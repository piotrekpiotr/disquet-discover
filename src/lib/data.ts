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

/**
 * Append a brand-new record to the pool. Used by the admin "Add release"
 * form to push a manually-sourced single/album into the pending queue.
 *
 * Rejects if a record with the same id already exists (callers should
 * pick a unique slug). Returns the stored record so the caller can mirror
 * it back into the admin UI without a reload.
 */
export async function addItem(rec: Recommendation): Promise<Recommendation | null> {
  const items = await loadAll();
  if (items.some((r) => r.id === rec.id)) return null;
  items.push(rec);
  // Keep the in-memory order newest-first so the next getAll() (uncached)
  // matches what you just appended. Not strictly required — getAll()
  // re-sorts — but it keeps the on-disk file readable.
  items.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  await persist(items);
  return rec;
}

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

/**
 * Case-insensitive substring match against the fields the curator is
 * most likely to recall: artist, title, label. Empty / whitespace-only
 * queries are treated as "no filter" so the function is safe to call
 * unconditionally — the admin UI passes `q` through whether or not the
 * search bar is in use, and the server doesn't have to care.
 */
function matchesSearch(rec: Recommendation, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${rec.artist} ${rec.title} ${rec.label}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Admin pool: 15 at a time, paginated by offset. Optional `q` is a
 * case-insensitive substring matched against artist + title + label;
 * when non-empty the result is the cross-status search hit list,
 * intersected with the chosen `filter` (so the four tabs continue to
 * act as refinements over the search rather than competing controls).
 */
export async function getPoolPage(
  filter: Status | "all",
  offset: number,
  limit = 15,
  q = "",
) {
  const all = await getAll();
  const byStatus =
    filter === "all" ? all : all.filter((r) => r.status === filter);
  const filtered = q.trim()
    ? byStatus.filter((r) => matchesSearch(r, q))
    : byStatus;
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

/**
 * Build a counts summary for admin tabs. When a search query is
 * supplied, counts reflect only records that match the query — so the
 * tab labels show how many results live in each status, helping the
 * curator jump straight to the right tab. Without a query (default),
 * the counts are global and the tabs behave as before.
 */
export async function getCounts(q = "") {
  const all = await getAll();
  const pool = q.trim() ? all.filter((r) => matchesSearch(r, q)) : all;
  return {
    total: pool.length,
    pending: pool.filter((r) => r.status === "pending").length,
    approved: pool.filter((r) => r.status === "approved").length,
    rejected: pool.filter((r) => r.status === "rejected").length,
  };
}
