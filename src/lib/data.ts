import { promises as fs } from "fs";
import path from "path";
import type { Recommendation, Status } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "recommendations.json");

// In-memory cache keyed by the file's last-modified timestamp. When the
// disk file is mutated by something OUTSIDE this process — git pull,
// scripted backfill, hand-edit, the daily-generate workflow committing
// a fresh batch — the cached `items` go stale. Old behaviour was a
// permanent module-level variable that only invalidated on `persist()`,
// which silently served stale data to readers (the public feed
// rendered without records the curator could clearly see were
// approved). Stat-on-read is cheap (~tens of microseconds) and lets
// the cache survive only as long as it's actually correct.
let cache: { items: Recommendation[]; mtimeMs: number } | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadAll(): Promise<Recommendation[]> {
  // Stat first to learn whether the cache is still good. If the file
  // doesn't exist (first-run, weird CWD) we re-read, which will
  // surface the underlying error to the caller.
  let mtimeMs: number;
  try {
    const stat = await fs.stat(DATA_FILE);
    mtimeMs = stat.mtimeMs;
  } catch {
    cache = null;
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as Recommendation[];
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.items;
  const raw = await fs.readFile(DATA_FILE, "utf-8");
  const items = JSON.parse(raw) as Recommendation[];
  cache = { items, mtimeMs };
  return items;
}

async function persist(items: Recommendation[]): Promise<void> {
  // Serialize writes to avoid concurrent file corruption
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8"),
  );
  await writeQueue;
  // Refresh cache with the new mtime so the next loadAll() short-
  // circuits to in-memory data without re-reading the file we just
  // wrote. Stat after the write so the mtime we cache matches the
  // file's actual on-disk timestamp (some filesystems round mtime to
  // seconds, so reusing Date.now() would mismatch on the next stat).
  try {
    const stat = await fs.stat(DATA_FILE);
    cache = { items, mtimeMs: stat.mtimeMs };
  } catch {
    cache = null;
  }
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
    // `links`: REPLACE not merge. The admin EditForm sends the full
    // canonical link map on every save (every key the form knows about,
    // omitted iff that field is empty). With a merge, an emptied field
    // just disappears from the patch and the old value sticks around —
    // so clearing a Bandcamp URL in admin "didn't" clear it. Replacing
    // makes empty mean empty.
    //
    // Patches from elsewhere (EmbedPicker, status changes, etc.) don't
    // include `links` at all, so the conditional below preserves
    // current.links untouched on those paths — only EditForm's full-
    // state save can wipe a link.
    links: patch.links ? patch.links : current.links,
    cover: patch.cover ? { ...current.cover, ...patch.cover } : current.cover,
  };
  items[idx] = merged;
  await persist(items);
  return merged;
}

/**
 * Composite sort key: "<releaseDate>|<id>". Two records that share a
 * release date were not comparable under the old date-only cursor —
 * the cursor was set to the page boundary's date and the next page
 * filtered `releaseDate < cursor`, which silently dropped any sibling
 * records with the SAME date. With three albums on 2026-04-17, only
 * two made it into page 1 and the third disappeared from pagination
 * entirely (mu tate / life of mu was the canonical victim).
 *
 * Adding the id as a tiebreaker turns the order into a strict
 * monotonic sequence, so a `key < cursor` filter is safe even when
 * the page boundary lands inside a same-date cluster. Id-as-tiebreak
 * is arbitrary but stable; the UI shows release dates and the date
 * grouping reads naturally regardless of intra-date ordering.
 */
function feedKey(r: Recommendation): string {
  return `${r.releaseDate}|${r.id}`;
}

/**
 * Get a public-feed page of 5: 2 singles + 3 albums-or-EPs.
 *
 * Records are ordered by composite (releaseDate, id) descending. The
 * `cursor` is the feedKey of the last item shown on the previous page;
 * a fresh request omits it. Records with the SAME releaseDate as the
 * cursor's record stay eligible for the next page so long as their id
 * is "smaller" — without this, same-day siblings vanish.
 *
 * Backwards compat: if a caller still passes a bare YYYY-MM-DD string
 * (the old cursor shape), `key < cursor + "|"` happens to behave
 * identically for the date-discriminated common case, so legacy
 * cursors keep paginating the way they used to.
 */
export async function getFeedPage(cursor?: string | null) {
  const approved = await getByStatus("approved");
  // Strict monotonic order: newer date first, then larger id first.
  const sorted = [...approved].sort((a, b) =>
    feedKey(b).localeCompare(feedKey(a)),
  );
  const filtered = cursor
    ? sorted.filter((r) => feedKey(r) < cursor)
    : sorted;

  const singles = filtered.filter((r) => r.type === "single");
  const longs = filtered.filter((r) => r.type === "album" || r.type === "ep");

  const pageSingles = singles.slice(0, 2);
  const pageLongs = longs.slice(0, 3);
  const items = [...pageSingles, ...pageLongs].sort((a, b) =>
    feedKey(b).localeCompare(feedKey(a)),
  );

  const nextCursor =
    items.length > 0 ? feedKey(items[items.length - 1]) : null;
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
 * "Today" in YYYY-MM-DD form. Used by the future-release filter so
 * single-day differences are deterministic across timezones (we
 * compare YYYY-MM-DD strings, not Date objects).
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Filter dimension that's orthogonal to status — UI 5th tab. */
export type AdminFilter = Status | "all" | "future";

/**
 * Admin pool: 15 at a time, paginated by offset. Optional `q` is a
 * case-insensitive substring matched against artist + title + label;
 * when non-empty the result is the cross-status search hit list,
 * intersected with the chosen `filter`.
 *
 * Filter dimension semantics:
 *   - "pending"  → status === pending AND releaseDate <= today.
 *     Releases with a future releaseDate (announce-now-drop-later
 *     singles like Tricky's 17-July one-off) are EXCLUDED from the
 *     working Pool tab so the curator's queue stays focused on what's
 *     ready to publish today.
 *   - "approved", "rejected" → straightforward status filter, no date
 *     constraint. Already-approved future releases stay in Published.
 *   - "all"     → everything, every status, every date.
 *   - "future"  → releaseDate > today, regardless of status. Sister
 *     view to Pool that surfaces the announced-but-unreleased queue.
 */
export async function getPoolPage(
  filter: AdminFilter,
  offset: number,
  limit = 15,
  q = "",
) {
  const all = await getAll();
  const today = todayIso();
  let byStatus: Recommendation[];
  if (filter === "all") {
    byStatus = all;
  } else if (filter === "future") {
    byStatus = all.filter((r) => (r.releaseDate || "") > today);
  } else if (filter === "pending") {
    byStatus = all.filter(
      (r) => r.status === "pending" && (r.releaseDate || "") <= today,
    );
  } else {
    byStatus = all.filter((r) => r.status === filter);
  }
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
 *
 * `pending` matches the Pool tab's filter (status=pending AND
 * releaseDate<=today) so the count on the tab matches what the tab
 * actually displays. `future` is a sibling count for the Future tab.
 */
export async function getCounts(q = "") {
  const all = await getAll();
  const pool = q.trim() ? all.filter((r) => matchesSearch(r, q)) : all;
  const today = todayIso();
  return {
    total: pool.length,
    pending: pool.filter(
      (r) => r.status === "pending" && (r.releaseDate || "") <= today,
    ).length,
    approved: pool.filter((r) => r.status === "approved").length,
    rejected: pool.filter((r) => r.status === "rejected").length,
    future: pool.filter((r) => (r.releaseDate || "") > today).length,
  };
}
