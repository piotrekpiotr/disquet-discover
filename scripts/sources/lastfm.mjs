/**
 * Last.fm as a SIMILARITY source — not a release source.
 *
 * Why Last.fm here:
 *   Last.fm's API is scrobble-first, not catalogue-first, so it's useless
 *   for "did this artist release something this week" (iTunes/Deezer/
 *   Discogs handle that). But `artist.getSimilar` is gold: given an
 *   artist, Last.fm returns the artists its listeners ALSO listen to,
 *   with a numeric match score (0–1). That turns into the signal we
 *   need to answer "is this press-mentioned candidate actually close
 *   enough to my pool to auto-add, or should I review manually?"
 *
 * How we use it:
 *   1. buildSimilarityIndex(poolArtists) builds a reverse-map:
 *        similarCandidate.lowercase → [{poolArtist, match}, ...]
 *      One Last.fm call per pool artist. At 250 artists + 200ms pacing
 *      this is ~60s of work, so we CACHE the index to disk for a week.
 *   2. scoreCandidate(candidateName, index) tells the media scan
 *      "this candidate is similar to X pool artists, best match is
 *      0.72 with Purelink" — which is enough to decide auto-promote
 *      vs. hold-for-review.
 *
 * Env:
 *   LASTFM_API_KEY — required. Read-only API methods don't need the
 *   shared secret or OAuth; the key alone is enough. Register at
 *   https://www.last.fm/api/account/create (callback URL can be
 *   https://disquet.co/ — Last.fm never calls it for read-only keys).
 *
 * If LASTFM_API_KEY is unset we silently skip similarity and return an
 * empty index; sync-media falls back to manual-review-only.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const API_BASE = "https://ws.audioscrobbler.com/2.0/";
const CACHE_FILE = path.resolve("data/lastfm-similarity-cache.json");
const CACHE_TTL_DAYS = 7;
const UA = "disquet-discover/1.0 +lastfm";

// Last.fm returns up to 100 similar artists per call. 50 is plenty —
// beyond that the match scores drop below our usable threshold.
const SIMILAR_LIMIT = 50;

// Match threshold below which we stop caring. Last.fm scores are
// empirically >0.6 for "clearly in the same scene", 0.3–0.6 for
// "adjacent scenes", <0.3 for "weak link". We keep >=0.2 in the cache
// so the score column in /admin/candidates has useful context even
// when the auto-promote threshold (0.3) isn't met.
const KEEP_MATCH_THRESHOLD = 0.2;

// Pacing. Last.fm's published limit is ~5 req/s per key; 250ms is
// comfortably under that and leaves headroom for retries.
const PER_CALL_MS = 250;

function apiKey() {
  return process.env.LASTFM_API_KEY || "";
}

async function lastfmGet(method, params) {
  const key = apiKey();
  if (!key) throw new Error("LASTFM_API_KEY not set");
  const qs = new URLSearchParams({
    method,
    api_key: key,
    format: "json",
    ...params,
  });
  const res = await fetch(`${API_BASE}?${qs.toString()}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) {
    throw new Error(`Last.fm ${method} ${res.status}`);
  }
  const json = await res.json();
  if (json?.error) {
    throw new Error(`Last.fm ${method} error ${json.error}: ${json.message || ""}`);
  }
  return json;
}

/**
 * Return up to SIMILAR_LIMIT similar artists for the given name. Each
 * entry is { name, match } where match is a number 0–1.
 *
 * Handles both "artist exists on Last.fm" (returns results) and
 * "artist doesn't exist / misspelled" (returns []). Never throws for
 * a missing artist — only for transport errors / quota issues.
 */
async function getSimilar(artistName) {
  try {
    const json = await lastfmGet("artist.getSimilar", {
      artist: artistName,
      limit: String(SIMILAR_LIMIT),
      autocorrect: "1",
    });
    const similar = json?.similarartists?.artist;
    if (!Array.isArray(similar)) return [];
    return similar
      .map((r) => ({
        name: typeof r?.name === "string" ? r.name.trim() : "",
        match: Number.parseFloat(r?.match || "0"),
      }))
      .filter((r) => r.name && Number.isFinite(r.match));
  } catch (e) {
    // Log and move on — one artist's failure doesn't doom the index build.
    console.log(`[lastfm] getSimilar("${artistName}") failed: ${e.message}`);
    return [];
  }
}

/**
 * Cache shape on disk (data/lastfm-similarity-cache.json):
 *
 *   {
 *     builtAt: "2026-04-24T06:00:00Z",
 *     poolArtistsCount: 250,
 *     // Reverse index: candidate-name-lowercased → [{poolArtist, match}, ...]
 *     similar: {
 *       "loidis": [{ poolArtist: "Huerco S.", match: 0.81 }, ...],
 *       ...
 *     }
 *   }
 *
 * Committing this to git is fine (it's small-ish, and pre-populating
 * fresh Actions runs is nice). Stale is safe: the cache is only used
 * to gate auto-promotion, and stale data just means slightly fewer
 * auto-promotions until the next rebuild.
 */
async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.builtAt || !parsed?.similar) return null;
    const ageDays =
      (Date.now() - new Date(parsed.builtAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (ageDays > CACHE_TTL_DAYS) {
      console.log(
        `[lastfm] cache is ${ageDays.toFixed(1)} days old (>${CACHE_TTL_DAYS}), will rebuild`,
      );
      return { stale: true, data: parsed };
    }
    return { stale: false, data: parsed };
  } catch {
    return null;
  }
}

async function writeCache(index, poolArtistsCount) {
  const payload = {
    builtAt: new Date().toISOString(),
    poolArtistsCount,
    similar: index,
  };
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (e) {
    console.log(`[lastfm] cache write failed: ${e.message}`);
  }
}

/**
 * Build (or refresh from cache) the reverse similarity index.
 *
 * Returns a Map<candidateLowercase, Array<{poolArtist, match}>> — the
 * Map is the in-memory shape; the cache on disk uses a plain object.
 *
 * Graceful degradation:
 *   - LASTFM_API_KEY missing → returns empty Map, logs once.
 *   - Fresh cache on disk → uses it as-is, no API calls.
 *   - Stale cache + API key present → rebuilds.
 *   - Stale cache + no API key → returns stale data (better than nothing).
 *   - Fresh rebuild fails mid-way → writes what it has and returns it.
 */
export async function buildSimilarityIndex(poolArtists) {
  if (!apiKey()) {
    console.log(
      "[lastfm] LASTFM_API_KEY not set — skipping similarity index (candidates will need manual review)",
    );
    return new Map();
  }

  const cached = await readCache();
  if (cached && !cached.stale) {
    console.log(
      `[lastfm] using cached similarity index (${Object.keys(cached.data.similar).length} entries, built ${cached.data.builtAt})`,
    );
    return toMap(cached.data.similar);
  }

  console.log(
    `[lastfm] building similarity index for ${poolArtists.length} pool artists…`,
  );
  /** @type {Record<string, Array<{poolArtist: string, match: number}>>} */
  const reverse = {};
  let done = 0;
  let withResults = 0;

  for (const poolArtist of poolArtists) {
    const similar = await getSimilar(poolArtist);
    if (similar.length > 0) withResults++;
    for (const { name, match } of similar) {
      if (match < KEEP_MATCH_THRESHOLD) continue;
      const k = name.toLowerCase();
      if (!reverse[k]) reverse[k] = [];
      // Skip self-matches (Last.fm occasionally returns the artist itself).
      if (k === poolArtist.toLowerCase()) continue;
      // Dedupe by poolArtist — some similar-lists overlap.
      if (reverse[k].some((x) => x.poolArtist === poolArtist)) continue;
      reverse[k].push({ poolArtist, match });
    }
    done++;
    if (done % 25 === 0) {
      console.log(
        `[lastfm] index build: ${done}/${poolArtists.length} (${withResults} had results)`,
      );
    }
    await new Promise((r) => setTimeout(r, PER_CALL_MS));
  }

  console.log(
    `[lastfm] index built: ${Object.keys(reverse).length} unique similar artists across ${done} pool artists`,
  );
  await writeCache(reverse, poolArtists.length);
  return toMap(reverse);
}

function toMap(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) m.set(k, v);
  }
  return m;
}

/**
 * Score a candidate artist against the pool. Returns:
 *   { matches: [{poolArtist, match}, ...], topMatch: number, poolMatchCount: number }
 *
 * A candidate is "similar to pool" if topMatch >= AUTO_PROMOTE_THRESHOLD
 * (default 0.3) OR if multiple pool artists each list it as similar
 * (poolMatchCount >= 2 regardless of score — the "many angles of the
 * pool all point at this artist" signal).
 */
export function scoreCandidate(candidateName, index) {
  const matches = index.get(candidateName.toLowerCase()) || [];
  const sorted = [...matches].sort((a, b) => b.match - a.match);
  return {
    matches: sorted,
    topMatch: sorted[0]?.match || 0,
    poolMatchCount: sorted.length,
  };
}

/** Threshold above which a single-pool-artist similarity is strong enough
 * to auto-promote on its own (when combined with multi-source press). */
export const AUTO_PROMOTE_MATCH_THRESHOLD = 0.3;

/** Pool-match count above which we auto-promote regardless of individual
 * match scores (many pool artists all list the candidate as similar). */
export const AUTO_PROMOTE_POOL_COUNT_THRESHOLD = 2;
