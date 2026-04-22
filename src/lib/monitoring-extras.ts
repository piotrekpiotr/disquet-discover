import { promises as fs } from "fs";
import path from "path";

/**
 * Curator-supplied additions to the monitoring pool.
 *
 * Why this file exists:
 *   The base monitoring pool lives in scripts/monitoring.mjs — it's
 *   hand-edited code and it requires a deploy to change. That's fine for
 *   deliberate, considered additions, but the curator also gets a steady
 *   trickle of "I just heard about this artist" tips where editing code
 *   + opening a PR is overkill. Those extras land here via the admin UI
 *   and get merged into the daily syncs without a redeploy.
 *
 * Shape on disk (`data/monitoring-extras.json`):
 *   { artists: ["Artist A", "Artist B"], labels: ["Label X"] }
 *
 * The file lives on the Railway persistent volume so it survives deploys.
 * The GitHub Actions sync scripts fetch it at run-time from the live site
 * (GET /api/monitoring-extras) and merge it into the hardcoded ARTISTS /
 * LABELS arrays before walking iTunes / Discogs.
 */

const FILE = path.join(process.cwd(), "data", "monitoring-extras.json");

export interface MonitoringExtras {
  artists: string[];
  labels: string[];
}

const EMPTY: MonitoringExtras = { artists: [], labels: [] };

let cache: MonitoringExtras | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<MonitoringExtras> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MonitoringExtras>;
    cache = {
      artists: Array.isArray(parsed.artists) ? parsed.artists.filter(isNonEmptyString) : [],
      labels: Array.isArray(parsed.labels) ? parsed.labels.filter(isNonEmptyString) : [],
    };
    return cache;
  } catch (e: unknown) {
    // File doesn't exist yet (fresh deploy, fresh volume, or local dev) —
    // treat as empty. Any other error is genuinely unexpected and rethrown.
    if (isEnoent(e)) {
      cache = { ...EMPTY };
      return cache;
    }
    throw e;
  }
}

async function persist(data: MonitoringExtras): Promise<void> {
  cache = data;
  writeQueue = writeQueue.then(() =>
    fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf-8"),
  );
  await writeQueue;
}

export async function getExtras(): Promise<MonitoringExtras> {
  const data = await load();
  // Defensive clone so callers can't mutate the in-memory cache.
  return { artists: [...data.artists], labels: [...data.labels] };
}

/**
 * Add a new artist or label. Trims input, rejects empty strings, and is
 * idempotent: adding a name that's already present (case-insensitive) is a
 * no-op and returns `{ added: false }`. Returns the updated full list so
 * the admin UI can re-render from the truth.
 */
export async function addExtra(
  kind: "artist" | "label",
  name: string,
): Promise<{ added: boolean; extras: MonitoringExtras }> {
  const trimmed = (name || "").trim();
  if (!trimmed) throw new Error("name is empty");
  const data = await load();
  const list = kind === "artist" ? data.artists : data.labels;
  const existing = list.find((x) => x.toLowerCase() === trimmed.toLowerCase());
  if (existing) return { added: false, extras: await getExtras() };
  const next: MonitoringExtras = {
    artists: kind === "artist" ? [...data.artists, trimmed].sort(byLower) : data.artists,
    labels: kind === "label" ? [...data.labels, trimmed].sort(byLower) : data.labels,
  };
  await persist(next);
  return { added: true, extras: await getExtras() };
}

export async function removeExtra(
  kind: "artist" | "label",
  name: string,
): Promise<{ removed: boolean; extras: MonitoringExtras }> {
  const trimmed = (name || "").trim();
  if (!trimmed) return { removed: false, extras: await getExtras() };
  const data = await load();
  const list = kind === "artist" ? data.artists : data.labels;
  const lower = trimmed.toLowerCase();
  const next: MonitoringExtras = { ...data };
  if (kind === "artist") {
    next.artists = list.filter((x) => x.toLowerCase() !== lower);
    if (next.artists.length === list.length)
      return { removed: false, extras: await getExtras() };
  } else {
    next.labels = list.filter((x) => x.toLowerCase() !== lower);
    if (next.labels.length === list.length)
      return { removed: false, extras: await getExtras() };
  }
  await persist(next);
  return { removed: true, extras: await getExtras() };
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "ENOENT"
  );
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function byLower(a: string, b: string) {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}
