import { NextResponse } from "next/server";
import { getAll } from "@/lib/data";

/**
 * GET /api/saved?ids=a,b,c
 *
 * Returns public-safe Recommendation objects for a client-supplied list of
 * IDs. Used by /saved to hydrate the records the user has favourited in
 * localStorage.
 *
 * Hardening notes:
 *   - Only APPROVED records are ever returned. Even though `getAll()` would
 *     happily return a pending/rejected record that someone guessed the ID
 *     for, we scope the result here so /api/saved can never be used to
 *     enumerate the moderation queue.
 *   - The `ids` query string is capped at 500 entries (arbitrary but way
 *     above any realistic user pinboard) so a long query can't slow the
 *     server down. Ids themselves are validated against a conservative
 *     character class.
 *   - Response preserves the order the user saved things in (i.e. the
 *     order of the `ids` query param) so the UI can render without
 *     re-sorting.
 */

const MAX_IDS = 500;
/** Record IDs in the dataset are slug-like; reject anything exotic early. */
const ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("ids") || "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && ID_RE.test(s))
    .slice(0, MAX_IDS);

  if (ids.length === 0) return NextResponse.json({ items: [] });

  const all = await getAll();
  // Only surface approved records. A saved ID that was later rejected
  // silently drops from the list rather than leaking its moderation status
  // to the client.
  const byId = new Map(
    all.filter((r) => r.status === "approved").map((r) => [r.id, r]),
  );
  const items = ids.map((id) => byId.get(id)).filter(Boolean);
  return NextResponse.json({ items });
}
