import { promises as fs } from "fs";
import path from "path";
import type { Recommendation, Status } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "recommendations.json");

let cache: Recommendation[] | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadAll(): Promise<Recommendation[]> {
  if (cache) return cache;
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  cache = JSON.parse(raw) as Recommendation[];
  return cache;
}

async function persist(items: Recommendation[]): Promise<void> {
  cache = items;
  // Serialize writes to avoid concurrent file corruption
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8"),
  );
  await writeQueue;
}

/** All items, newest releaseDate first. */
export async function getAll(): Promise<Recommendation[]> {
  const items = await loadAll();
  return [...items].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
}

/**
 * Lookup a single item by id. Returns null when not found OR (if
 * `approvedOnly` is true) when the record's status isn't "approved". Public
 * routes pass `approvedOnly: true` so an ID guess can never leak a pending
 * or rejected record.
 */
export async function getById(
  id: string,
  approvedOnly = false,
): Promise<Recommendation | null> {
  const items = await loadAll();
  const hit = items.find((r) => r.id === id) || null;
  if (!hit) return null;
  if (approvedOnly && hit.status !== "approved") return null;
  return hit;
}

/** Items with given status, newest releaseDate first. */
export async function getByStatus(status: Status): Promise<Recommendation[]> {
  const all = await getAll();
  return all.filter((r) => r.status === status);
}

/** Mutate item status. Sets approvedAt when approving. */
export async function setStatus(id: string, status: Status): Promise<Recommendation | null> {
  const items = await loadAll();
  const idx = items.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  items[idx] = {
    ...items[idx],
    status,
    approvedAt: status === "approved" ? new Date().toISOString() : null,
  };
  await persist(items);
  return items[idx];
}

/** Fields the admin can freely edit. id/status/approvedAt are managed elsewhere. */
export type EditablePatch = Partial<
  Pick<
    Recommendation,
    | "type"
    | "artist"
    | "title"
    | "label"
    | "releaseDate"
    | "description"
    | "tags"
    | "links"
    | "coverImageUrl"
    | "musicVideoUrl"
    | "cover"
    | "embed"
  >
>;

/** Apply a partial edit to a single item. Returns the updated record. */
export async function updateItem(
  id: string,
  patch: EditablePatch,
): Promise<Recommendation | null> {
  const items = await loadAll();
  const idx = items.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = items[idx];
  const merged: Recommendation = {
    ...current,
    ...patch,
    links: patch.links ? { ...current.links, ...patch.links } : current.links,
    cover: patch.cover ? { ...current.cover, ...patch.cover } : current.cover,
  };
  items[idx] = merged;
  await persist(items);
  return merged;
}

/**
 * Get a public-feed page of 5: 2 singles + 3 albums-or-EPs.
 * Pulls from approved items only, ordered newest releaseDate first.
 * `cursor` is the releaseDate of the last item from the previous page (exclusive).
 */
export async function getFeedPage(cursor?: string | null) {
  const approved = await getByStatus("approved");
  const filtered = cursor ? approved.filter((r) => r.releaseDate < cursor) : approved;

  const singles = filtered.filter((r) => r.type === "single");
  const longs = filtered.filter((r) => r.type === "album" || r.type === "ep");

  const pageSingles = singles.slice(0, 2);
  const pageLongs = longs.slice(0, 3);
  const items = [...pageSingles, ...pageLongs].sort((a, b) =>
    b.releaseDate.localeCompare(a.releaseDate),
  );

  const nextCursor = items.length > 0 ? items[items.length - 1].releaseDate : null;
  // hasMore: there must be enough remaining items of *each* required type
  const remainingAfter = filtered.filter(
    (r) => !items.find((i) => i.id === r.id),
  );
  const hasMore =
    remainingAfter.filter((r) => r.type === "single").length >= 2 &&
    remainingAfter.filter((r) => r.type !== "single").length >= 3;

  return { items, nextCursor, hasMore };
}

/** Admin pool: 15 at a time, paginated by offset. */
export async function getPoolPage(filter: Status | "all", offset: number, limit = 15) {
  const all = await getAll();
  const filtered = filter === "all" ? all : all.filter((r) => r.status === filter);
  const items = filtered.slice(offset, offset + limit);
  return { items, total: filtered.length, hasMore: offset + limit < filtered.length };
}

/**
 * Most recent approvedAt across all published records, or null if the feed is
 * empty. Used on the home page "Last update" strip so the chrome reflects the
 * actual catalogue state, not the server clock.
 */
export async function getLatestPublishedAt(): Promise<string | null> {
  const all = await loadAll();
  let latest: string | null = null;
  for (const r of all) {
    if (r.status !== "approved") continue;
    const stamp = r.approvedAt || r.releaseDate || null;
    if (!stamp) continue;
    if (!latest || stamp.localeCompare(latest) > 0) latest = stamp;
  }
  return latest;
}

/** Build a counts summary for admin tabs. */
export async function getCounts() {
  const all = await getAll();
  return {
    total: all.length,
    pending: all.filter((r) => r.status === "pending").length,
    approved: all.filter((r) => r.status === "approved").length,
    rejected: all.filter((r) => r.status === "rejected").length,
  };
}
