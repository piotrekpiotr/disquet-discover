/**
 * Bandcamp Discover as a release/candidate source.
 *
 * Why this source vs. the dozen GitHub Bandcamp scrapers:
 *   We researched the major open-source Bandcamp clients on GitHub
 *   (bandcamp-fetch, bandcamp-dl, bandcamp-api, etc.). Most are HTML
 *   scrapers wrapped in npm packages. Three concrete reasons we
 *   declined to depend on any of them:
 *
 *     1. Supply-chain risk. Pulling a third-party package into the
 *        daily sync is more attack surface for a curator-tools repo.
 *     2. Maintenance lag. When Bandcamp changes their HTML the
 *        scrapers break and we wait for the upstream maintainer to
 *        ship a fix.
 *     3. We don't need most of what those packages do (downloads,
 *        wishlists, label search). We need ONE thing: the latest
 *        releases for a given tag, sorted by date.
 *
 *   It turns out Bandcamp ships a public JSON endpoint that powers
 *   their own /discover page:
 *
 *     GET https://bandcamp.com/api/discover/3/get_web
 *         ?g=<genre_id>      // 0 = all, 10 = electronic, etc.
 *         &t=<tag_slug>      // "dub-techno", "ambient", …
 *         &s=date            // sort by publish date (descending)
 *         &p=<page>          // 0-indexed, 48 items per page
 *
 *   Returns clean JSON with primary_text (title), secondary_text
 *   (artist), publish_date, art_id, and url_hints (subdomain + slug
 *   to construct a real Bandcamp URL). No HTML parsing, no
 *   dependency, ~30 lines of code in this file. Stable since the
 *   2024 Discover redesign.
 *
 * What this surfaces:
 *   For each tag in the pool's Last.fm fingerprint (or a hardcoded
 *   fallback list when the fingerprint is unavailable), we pull the
 *   latest 48 releases. Then for each release:
 *
 *     - If the artist matches an existing pool member → SKIP. The
 *       per-artist iTunes/Deezer scan in sync-artists.mjs already
 *       handles that record's discovery; we don't need to add a
 *       duplicate entry from Bandcamp.
 *     - If the artist is NEW → return as a candidate row with
 *       source="bandcamp-discover", along with the matching tag and
 *       the Bandcamp URL so the curator can audition immediately.
 *
 * Cost:
 *   ~20 fingerprint tags × 1 API call each = ~20 calls per run.
 *   Bandcamp's edge has been tolerant of this volume in testing; we
 *   pace at 600ms between calls anyway. Total time per run: ~12s.
 *
 * Failure modes:
 *   - Empty/error response on any tag → log and skip that tag,
 *     continue with the rest.
 *   - Bandcamp rate-limits or 403s → returns []. The press feeds
 *     and other sources still produce candidates that run.
 */

const API_BASE = "https://bandcamp.com/api/discover/3/get_web";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Genre ID 10 = "electronic" on Bandcamp's taxonomy. We pin to that
// because the pool's centre of gravity is electronic / leftfield-
// electronic; querying without a genre filter pulls in too much pop /
// rock for the candidates list to stay relevant. If the pool ever
// expands meaningfully into other primary genres we can make this
// configurable per-tag.
const ELECTRONIC_GENRE_ID = 10;

// Pacing between Bandcamp API calls. 600ms is well under any
// observed throttling threshold and leaves headroom on retries.
const PER_CALL_MS = 600;

// Hardcoded fallback tag list — used when the Last.fm fingerprint
// hasn't been built yet (first-ever run, missing API key, …). Picks
// the densest tags in the curator's typical pool composition so the
// first run still produces useful candidates.
const FALLBACK_TAGS = [
  "ambient",
  "dub-techno",
  "idm",
  "experimental-electronic",
  "techno",
  "dub",
  "ambient-techno",
  "deep-house",
  "downtempo",
  "leftfield",
];

/**
 * Slugify a Last.fm tag the way Bandcamp expects in their `t=` query
 * param. Bandcamp uses lowercase + dashes, same as Last.fm's tag
 * URLs in fact, so the conversion is mostly a normalisation pass.
 */
function tagToSlug(tag) {
  return (tag || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build a public Bandcamp URL for a release item using the API's
 * `url_hints` field. Result shape: https://<subdomain>.bandcamp.com/
 * (album|track)/<slug>. When url_hints is incomplete (rare), return
 * null and let the caller drop the item.
 */
function bandcampUrlFor(item) {
  const h = item?.url_hints || {};
  if (!h.subdomain || !h.slug) return null;
  const kind = h.item_type === "t" ? "track" : "album";
  return `https://${h.subdomain}.bandcamp.com/${kind}/${h.slug}`;
}

/**
 * Convert Bandcamp's "07 Mar 2026 20:17:57 GMT" publish_date to the
 * YYYY-MM-DD form the rest of the pipeline uses. Returns "" on any
 * parse failure so downstream filters drop the item rather than
 * propagating a bad date.
 */
function parsePublishDate(s) {
  if (!s) return "";
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

async function polite() {
  await new Promise((r) => setTimeout(r, PER_CALL_MS));
}

async function discoverByTag(tag) {
  const slug = tagToSlug(tag);
  if (!slug) return [];
  const url = `${API_BASE}?g=${ELECTRONIC_GENRE_ID}&t=${encodeURIComponent(
    slug,
  )}&s=date&p=0`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      console.log(`[bandcamp-discover] ${tag} -> ${res.status}`);
      return [];
    }
    const j = await res.json();
    const items = Array.isArray(j?.items) ? j.items : [];
    return items;
  } catch (e) {
    console.log(`[bandcamp-discover] ${tag} fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Public API: walk a list of tags, accumulate non-pool candidates
 * with their Bandcamp URL + matching tag.
 *
 * `pooledSet`  — Set of normalised (lowercased, trimmed) pool artist
 *                names to skip. Same shape as sync-media.mjs uses.
 * `tags`       — array of tag strings. Pass the Last.fm fingerprint
 *                tags here, or null to use the FALLBACK_TAGS list.
 *
 * Returns array of { name, url, releaseTitle, releaseDate, tag, type }
 * sorted by releaseDate descending. The caller merges into media-
 * candidates with source="bandcamp-discover".
 */
export async function findFreshReleases({ pooledSet, tags }) {
  const tagList = tags && tags.length ? tags : FALLBACK_TAGS;
  /** @type {Map<string, {name: string, url: string, releaseTitle: string, releaseDate: string, tags: Set<string>, type: string}>} */
  const seen = new Map();

  for (const tag of tagList) {
    const items = await discoverByTag(tag);
    for (const it of items) {
      const artist = (it?.secondary_text || "").trim();
      const albumTitle = (it?.primary_text || "").trim();
      if (!artist || !albumTitle) continue;
      const key = artist.toLowerCase();
      if (pooledSet.has(key)) continue;

      const url = bandcampUrlFor(it);
      if (!url) continue;
      const releaseDate = parsePublishDate(it.publish_date);
      const type = it?.url_hints?.item_type === "t" ? "track" : "album";

      const cur = seen.get(key) || {
        name: artist,
        url,
        releaseTitle: albumTitle,
        releaseDate,
        tags: new Set(),
        type,
      };
      cur.tags.add(tag);
      // Prefer the most-recent release if we hit the same artist
      // under multiple tags.
      if (releaseDate > cur.releaseDate) {
        cur.releaseDate = releaseDate;
        cur.releaseTitle = albumTitle;
        cur.url = url;
        cur.type = type;
      }
      seen.set(key, cur);
    }
    await polite();
  }

  const rows = Array.from(seen.values()).map((v) => ({
    name: v.name,
    url: v.url,
    releaseTitle: v.releaseTitle,
    releaseDate: v.releaseDate,
    tags: Array.from(v.tags).sort(),
    type: v.type,
  }));
  rows.sort((a, b) =>
    (b.releaseDate || "").localeCompare(a.releaseDate || ""),
  );
  console.log(
    `[bandcamp-discover] surfaced ${rows.length} non-pool fresh-release candidates ` +
      `across ${tagList.length} tag(s)`,
  );
  return rows;
}
