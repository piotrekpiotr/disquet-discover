/**
 * Last.fm tag-based discovery — find candidate artists OUTSIDE the
 * pool by sharing genre fingerprint with what we already track.
 *
 * Why this matters:
 *   The press-feed scan (sync-media.mjs) only catches artists who got
 *   reviewed in a publication this week. Plenty of left-field
 *   electronic artists never get a Pitchfork / RA review and are
 *   completely invisible to that pipeline. But Last.fm's tag system
 *   is community-edited, dense for our genre, and free via API. If we
 *   can identify "what the pool sounds like" as a tag fingerprint,
 *   we can surface non-pool artists that share that fingerprint.
 *
 * Method:
 *   1. POOL FINGERPRINT (artist.getTopTags). For every pool artist,
 *      fetch their top tags. Aggregate into a tag → frequency map.
 *      Top ~20 most-frequent tags ARE our genre fingerprint
 *      ("ambient", "dub techno", "idm", "experimental electronic", …).
 *      Cached on disk for 7 days — the pool composition shifts slowly
 *      and there's no point regenerating this every run.
 *
 *   2. TAG-WISE TOP ARTISTS (tag.getTopArtists). For each fingerprint
 *      tag, pull Last.fm's top ~50 artists for that tag. These are
 *      ranked by listen count, not freshness, so we get a wide net of
 *      "names credible in the genre", whether or not they shipped
 *      anything this week.
 *
 *   3. SCORE & CANDIDATE. For each non-pool artist returned, count
 *      how many of OUR fingerprint tags they appear under. An artist
 *      that hits 4 of our 20 tags is a stronger fit than one that
 *      hits 1. The score + the matching tags get persisted on the
 *      candidate so the curator sees the WHY at /admin/candidates.
 *
 * Output:
 *   Returns an array of { name, tags: [...], score } where score is
 *   the count of fingerprint tags this artist appears under. The
 *   caller (sync-media.mjs) merges these into media-candidates.json
 *   with `source: "lastfm-tags"`. Existing dismissed/promoted entries
 *   are NOT re-surfaced — same logic as press candidates.
 *
 * Rate limits & cost:
 *   Last.fm allows ~5 req/sec per key. Pool of ~260 artists × 1 call
 *   each = ~52s (with 200ms pacing). Top-tag pass = ~20 calls = ~4s.
 *   Total ~1 minute per run; well under the 30k-call/day soft limit.
 *
 * Failure modes:
 *   No LASTFM_API_KEY → returns []. Caller proceeds without the new
 *   signal. A stale fingerprint (>7 days) is silently rebuilt; if the
 *   rebuild fails (rate limit, network), we use the stale cache so we
 *   degrade gracefully rather than going dark.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const API_BASE = "https://ws.audioscrobbler.com/2.0/";
const FINGERPRINT_CACHE = path.resolve("data/lastfm-tag-fingerprint.json");
const FINGERPRINT_TTL_DAYS = 7;
const UA = "disquet-discover/1.0 +lastfm-tags";

// Tag-discovery knobs. Tunable here without touching the orchestrator.
const POOL_TOP_TAGS_PER_ARTIST = 5; // how many tags per pool artist
const FINGERPRINT_SIZE = 20; // top-N tags across the pool
const TAG_TOP_ARTISTS_LIMIT = 50; // how many candidates per tag
const MIN_TAG_OVERLAP = 2; // min fingerprint tags to qualify as candidate
const PER_CALL_MS = 220; // pacing under Last.fm's 5/sec limit

// Tags that show up frequently in everyone's top-tags but tell us
// nothing about genre fit. "seen live", "british", "favorites", and
// the like would otherwise dominate the fingerprint and yield top-
// artists lists full of country/region-mates rather than scene
// adjacents. Curated empirically; expand as needed.
const STOPWORD_TAGS = new Set([
  "seen live",
  "favorites",
  "favourites",
  "favorite",
  "favourite",
  "british",
  "american",
  "english",
  "polish",
  "german",
  "japanese",
  "swedish",
  "canadian",
  "uk",
  "usa",
  "europe",
  "male vocalists",
  "female vocalists",
  "instrumental",
  "rip",
  "concert",
  "60s",
  "70s",
  "80s",
  "90s",
  "00s",
  "10s",
  "20s",
  "2020s",
  "2021",
  "2022",
  "2023",
  "2024",
  "2025",
  "2026",
  "all",
  "artists i've seen live",
  "best",
  "best of",
  "top",
]);

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
    throw new Error(
      `Last.fm ${method} error ${json.error}: ${json.message || ""}`,
    );
  }
  return json;
}

function normaliseTag(t) {
  return (t || "").toLowerCase().trim();
}

function normaliseArtistKey(a) {
  return (a || "").toLowerCase().trim();
}

async function polite() {
  await new Promise((r) => setTimeout(r, PER_CALL_MS));
}

/**
 * Fetch top tags for a single artist. Returns an array of normalised
 * tag strings, capped at POOL_TOP_TAGS_PER_ARTIST. Stop-word tags are
 * filtered out at this stage so they never enter the fingerprint.
 *
 * Empty array on any error — fingerprint building is best-effort,
 * losing a few artists' tags doesn't significantly bias the result.
 */
async function topTagsForArtist(artistName) {
  try {
    const j = await lastfmGet("artist.getTopTags", { artist: artistName });
    const raw = j?.toptags?.tag;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const tags = list
      .map((t) => normaliseTag(t?.name))
      .filter(Boolean)
      .filter((t) => !STOPWORD_TAGS.has(t))
      .slice(0, POOL_TOP_TAGS_PER_ARTIST);
    return tags;
  } catch (e) {
    console.log(`[lastfm-tags] getTopTags("${artistName}") failed: ${e.message}`);
    return [];
  }
}

/**
 * Build (or reuse cached) tag fingerprint for the pool. The cache
 * shape on disk:
 *   {
 *     builtAt: ISO,
 *     poolSize: number,
 *     tagCounts: { "ambient": 47, "dub techno": 23, ... }  // ALL tags
 *     fingerprint: ["ambient", "dub techno", ...]          // top FINGERPRINT_SIZE
 *   }
 * We keep the full tagCounts so future-tweaking FINGERPRINT_SIZE or
 * the stopword list can be done from cached data without rebuilding.
 */
export async function buildFingerprint(poolArtists) {
  const cached = await readFingerprintCache();
  const ageDays = cached
    ? (Date.now() - new Date(cached.builtAt).getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;
  if (cached && ageDays < FINGERPRINT_TTL_DAYS && cached.poolSize === poolArtists.length) {
    console.log(
      `[lastfm-tags] using cached fingerprint (${cached.fingerprint.length} tags, built ${cached.builtAt})`,
    );
    return cached;
  }
  if (!apiKey()) {
    console.log(
      "[lastfm-tags] LASTFM_API_KEY not set — skipping tag discovery",
    );
    return null;
  }

  console.log(
    `[lastfm-tags] building fingerprint for ${poolArtists.length} pool artists…`,
  );
  const tagCounts = {};
  let done = 0;
  for (const artist of poolArtists) {
    const tags = await topTagsForArtist(artist);
    for (const t of tags) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
    done++;
    if (done % 50 === 0) {
      console.log(
        `[lastfm-tags] fingerprint progress: ${done}/${poolArtists.length}`,
      );
    }
    await polite();
  }

  const fingerprint = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FINGERPRINT_SIZE)
    .map(([t]) => t);

  const out = {
    builtAt: new Date().toISOString(),
    poolSize: poolArtists.length,
    tagCounts,
    fingerprint,
  };
  await writeFingerprintCache(out);
  console.log(
    `[lastfm-tags] fingerprint built. Top tags: ${fingerprint.slice(0, 10).join(", ")}`,
  );
  return out;
}

async function readFingerprintCache() {
  try {
    const raw = await fs.readFile(FINGERPRINT_CACHE, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.builtAt === "string" &&
      Array.isArray(parsed?.fingerprint) &&
      typeof parsed?.tagCounts === "object" &&
      typeof parsed?.poolSize === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeFingerprintCache(data) {
  try {
    await fs.writeFile(FINGERPRINT_CACHE, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.log(`[lastfm-tags] cache write failed: ${e.message}`);
  }
}

/**
 * Fetch top artists for one tag. Returns an array of artist names.
 * Last.fm capitalises consistently, so we keep the case from the
 * response (used as the displayed name).
 */
async function topArtistsForTag(tag) {
  try {
    const j = await lastfmGet("tag.getTopArtists", {
      tag,
      limit: TAG_TOP_ARTISTS_LIMIT,
    });
    const raw = j?.topartists?.artist;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .map((a) => (typeof a?.name === "string" ? a.name.trim() : ""))
      .filter(Boolean);
  } catch (e) {
    console.log(`[lastfm-tags] getTopArtists("${tag}") failed: ${e.message}`);
    return [];
  }
}

/**
 * Walk the fingerprint and collect non-pool artists with score = how
 * many fingerprint tags they appear under. Higher score = stronger
 * fit. Returns sorted-by-score-desc.
 *
 * `excludeKeys` is the set of normalised pool + monitoring-extras
 * artist names to skip; usually `mergeUnique(BASE_ARTISTS, extras.artists)`
 * lower-cased. The caller is responsible for not re-adding artists
 * that media-candidates already has dismissed/promoted (sync-media's
 * existing dedup handles that).
 */
export async function findTagCandidates(fingerprint, excludeKeys) {
  if (!fingerprint || !apiKey()) return [];

  /** @type {Map<string, {name: string, tags: Set<string>}>} */
  const candidates = new Map();
  for (const tag of fingerprint.fingerprint) {
    const artists = await topArtistsForTag(tag);
    for (const name of artists) {
      const key = normaliseArtistKey(name);
      if (excludeKeys.has(key)) continue;
      const cur = candidates.get(key) || { name, tags: new Set() };
      cur.tags.add(tag);
      // Prefer the longer / more "proper" capitalisation we've seen
      // for this artist. Last.fm returns slightly different casing
      // across endpoints sometimes.
      if (name.length > cur.name.length) cur.name = name;
      candidates.set(key, cur);
    }
    await polite();
  }

  const rows = [];
  for (const v of candidates.values()) {
    if (v.tags.size < MIN_TAG_OVERLAP) continue;
    rows.push({
      name: v.name,
      tags: Array.from(v.tags).sort(),
      score: v.tags.size,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  console.log(
    `[lastfm-tags] surfaced ${rows.length} non-pool candidates ` +
      `(>=${MIN_TAG_OVERLAP} fingerprint-tag overlap)`,
  );
  return rows;
}
