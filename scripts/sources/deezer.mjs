/**
 * Deezer as a per-artist release fallback source.
 *
 * Why Deezer:
 *   - Unauthenticated public API (no key, no OAuth, no account).
 *   - Updates same-day when labels push releases, same as Apple Music.
 *   - Runs on a different infra than Apple — a runner IP blocked by
 *     iTunes is almost always accepted by Deezer, and vice versa.
 *     This is the single biggest reliability win for a workflow that
 *     runs from GitHub Actions IPs known to trigger bot filters.
 *   - Rate limit is 50 req / 5s per IP, far more generous than iTunes
 *     in practice.
 *
 * Contract is the same as sources/itunes.mjs:
 *   lookupArtist(artistName) → Promise<Release[]>
 *     - Throws if all retries fail. Orchestrator catches.
 *     - No freshness filter, no caps — caller decides.
 *
 * Two-step flow:
 *   1. /search/artist?q=<name>&limit=5 to find the Deezer artist id.
 *      Deezer's search is forgiving; we pick the match whose name
 *      equals the query (case-insensitively) to avoid grabbing a
 *      different artist that merely shares a substring.
 *   2. /artist/<id>/albums?limit=50 to list every album/EP/single.
 *      Deezer returns them newest-first in release_date order.
 */

const UA = "disquet-discover/1.0 +deezer";
const RETRIES = 3;

function normalise(s) {
  return (s || "").toLowerCase().trim();
}

async function deezerGet(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return res.json();
      // 4xx (other than 429) won't heal with a retry — give up fast so
      // the orchestrator can move on rather than waiting through a full
      // backoff on a permanent error.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Deezer ${res.status}`);
      }
      lastErr = new Error(`Deezer ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    const delay = 500 * Math.pow(2, attempt - 1) + Math.random() * 300;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw lastErr || new Error(`Deezer GET failed: ${url}`);
}

/**
 * Find the Deezer artist id that best matches `name`. Deezer's search is
 * lenient, so we require an exact name match (case-insensitive) to avoid
 * "aya" hitting some random artist called "Ayana" first. Falls back to
 * the top result ONLY if it has zero fuzz room (trimmed equal names).
 *
 * Returns null if no confident match — the orchestrator treats this the
 * same as "no releases for this artist today" and moves on.
 */
async function findArtistId(name) {
  const q = encodeURIComponent(name);
  const url = `https://api.deezer.com/search/artist?q=${q}&limit=5`;
  const json = await deezerGet(url);
  const results = Array.isArray(json?.data) ? json.data : [];
  const wanted = normalise(name);
  for (const r of results) {
    if (normalise(r.name) === wanted) return r.id;
  }
  return null;
}

/**
 * Map Deezer's record_type values to our {album, ep, single} vocabulary.
 * Deezer only reports "album", "ep", "single" directly on albums;
 * "compile" (compilations) we treat as album for consistency.
 */
function pickReleaseType(record_type, nb_tracks) {
  if (record_type === "single") return "single";
  if (record_type === "ep") return "ep";
  if (typeof nb_tracks === "number") {
    if (nb_tracks <= 3) return "single";
    if (nb_tracks <= 6) return "ep";
  }
  return "album";
}

/**
 * Public API: every recent release on Deezer for this artist, normalised
 * to the shared Release shape. Throws on network/API failure; orchestrator
 * decides what to do.
 */
export async function lookupArtist(artistName) {
  const id = await findArtistId(artistName);
  if (!id) return [];

  const url = `https://api.deezer.com/artist/${id}/albums?limit=50`;
  const json = await deezerGet(url);
  const albums = Array.isArray(json?.data) ? json.data : [];

  const out = [];
  const seen = new Set();
  for (const a of albums) {
    if (!a?.id) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);

    const title = (a.title || "").trim();
    const releaseDate = (a.release_date || "").slice(0, 10);
    if (!title || !releaseDate) continue;

    out.push({
      source: "deezer",
      sourceId: a.id,
      artist: a.artist?.name || artistName,
      title,
      releaseType: pickReleaseType(a.record_type, a.nb_tracks),
      releaseDate,
      artworkUrl: a.cover_xl || a.cover_big || a.cover_medium || null,
      externalUrl: a.link || null,
      // Deezer's album endpoint doesn't include label on the listing;
      // fetching each album detail would triple our request count for
      // marginal value. Let enrich-labels-and-embeds fill this in later.
      label: "",
      // Genre ids are on the album but require a separate /genre lookup;
      // not worth the hop — tags are a nice-to-have, not a must.
      tag: "",
    });
  }
  out.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  return out;
}
