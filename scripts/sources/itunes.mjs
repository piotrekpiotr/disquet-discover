/**
 * iTunes / Apple Music search as a per-artist release source.
 *
 * Extracted out of the old monolithic sync-itunes.mjs so the orchestrator
 * (sync-artists.mjs) can treat this as one source among several and fall
 * back to Deezer / MusicBrainz when Apple throttles the runner IP.
 *
 * Contract:
 *   lookupArtist(artistName) → Promise<Release[]>
 *     - Returns ALL releases iTunes reports for that artist, normalised
 *       into the shared Release shape (see Release docstring below).
 *     - Filters to releases matching the artist exactly or as a tokenised
 *       collaborator credit ("Purelink & Rainy Miller" still matches for
 *       either half of the name).
 *     - No freshness filter, no per-artist cap — the orchestrator decides
 *       what to keep.
 *     - Throws on unrecoverable error (all retries exhausted). The caller
 *       catches and tries the next source.
 *
 * Rate limiting:
 *   ~200ms between calls at the caller (orchestrator) level. iTunes tends
 *   to block with 403 bursts when a single IP blasts; retries here back
 *   off exponentially (0.6s, 1.8s, 5.4s) before surrendering to the
 *   orchestrator so it can fall through to another source.
 */

const UA = "disquet-discover/1.0 +itunes";
const RETRIES = 3;

/**
 * Shared Release shape across all sources. Every field except `source` and
 * `sourceId` is a best-effort normalisation; consumers should tolerate
 * empty strings / nulls.
 *
 * @typedef {{
 *   source: "itunes" | "deezer",
 *   sourceId: string | number,
 *   artist: string,
 *   title: string,
 *   releaseType: "album" | "ep" | "single",
 *   releaseDate: string,         // YYYY-MM-DD
 *   artworkUrl: string | null,
 *   externalUrl: string | null,  // deep link back to the source
 *   label: string,                // best-effort, may be "" when unknown
 *   tag: string,                  // primary genre, lowercase, may be ""
 * }} Release
 */

function artworkLarge(url) {
  if (!url) return null;
  // iTunes returns 100x100 by default; bump to 600x600 for the card / PDF.
  return url.replace(/\/\d+x\d+(bb)?\./, "/600x600bb.");
}

function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
}

function pickReleaseType(result) {
  if (/-\s*single$/i.test(result.collectionName || "")) return "single";
  if (/-\s*ep$/i.test(result.collectionName || "")) return "ep";
  if (result.trackCount && result.trackCount <= 3) return "single";
  if (result.trackCount && result.trackCount <= 6) return "ep";
  return "album";
}

/**
 * iTunes doesn't expose a dedicated `label` field on search results, but the
 * copyright line on most releases looks like "℗ 2026 Fixed Abode" — we
 * strip ℗/©/year to get a usable fallback. Later enrichment (Discogs) can
 * overwrite this when it has a confident match.
 */
function labelFromCopyright(copyright) {
  if (!copyright) return "";
  return copyright
    .replace(/[℗©]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArtist(a) {
  return (a || "").toLowerCase().trim();
}

/**
 * Split an iTunes artistName into its collaborator tokens so a joint
 * release credited "Purelink & Rainy Miller" matches both Purelink and
 * Rainy Miller entries in the pool. Covers ampersand, slash, comma,
 * semicolon, "x", "vs", "with", "feat"/"ft"/"featuring".
 */
function splitArtistCredits(artistName) {
  if (!artistName) return [];
  const cleaned = artistName
    .replace(/\s+(?:feat\.?|featuring|ft\.?|vs\.?|with|x)\s+/gi, "|")
    .replace(/[,&/;·+]/g, "|");
  return cleaned
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesArtist(result, wanted) {
  const wantedNorm = normalizeArtist(wanted);
  if (normalizeArtist(result.artistName) === wantedNorm) return true;
  for (const token of splitArtistCredits(result.artistName)) {
    if (normalizeArtist(token) === wantedNorm) return true;
  }
  return false;
}

/**
 * Call iTunes search with retry + backoff. Throws if all retries fail.
 */
async function itunesSearch(artistName) {
  // attribute=artistTerm — scope the search to the artist field only so
  // short names ("aya", "LOG") don't get drowned in track-title noise.
  // entity=album returns RELEASE collections: LPs, EPs, AND singles (which
  // iTunes packages as collections like "Barrons Hotel - Single"). This is
  // the canonical "a new release came out" unit.
  const term = encodeURIComponent(artistName);
  const url = `https://itunes.apple.com/search?term=${term}&entity=album&limit=25&media=music&attribute=artistTerm`;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const json = await res.json();
        return Array.isArray(json.results) ? json.results : [];
      }
      lastErr = new Error(`iTunes ${res.status}`);
      const delay = 600 * Math.pow(3, attempt - 1) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, delay));
    } catch (e) {
      lastErr = e;
      const delay = 600 * Math.pow(3, attempt - 1) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error(`iTunes lookup failed for ${artistName}`);
}

/**
 * Normalise an iTunes search result into the shared Release shape.
 * Returns null for results that don't carry enough signal to be worth
 * keeping (no collection id, no title, no release date).
 */
function normaliseResult(result) {
  const rawTitle = result.collectionName || result.trackName || "";
  const title = cleanTitle(rawTitle);
  const sourceId = result.collectionId || result.trackId;
  const releaseDate = (result.releaseDate || "").slice(0, 10);
  if (!title || !sourceId || !releaseDate) return null;

  const externalUrl = (result.collectionViewUrl || result.trackViewUrl || "")
    .split("?")[0];

  return {
    source: "itunes",
    sourceId,
    artist: result.artistName || "",
    title,
    releaseType: pickReleaseType(result),
    releaseDate,
    artworkUrl: artworkLarge(result.artworkUrl100 || result.artworkUrl60),
    externalUrl: externalUrl || null,
    label: labelFromCopyright(result.copyright),
    tag: (result.primaryGenreName || "").toLowerCase(),
  };
}

/**
 * Public API: return every release iTunes reports for this artist, filtered
 * to rows where the artist actually matches (strict, collaborator-aware),
 * deduped by sourceId, sorted newest-first.
 *
 * Throws on unrecoverable network / 403 after all retries. Orchestrator
 * catches and tries the next source (Deezer) before giving up on the
 * artist for this run.
 */
export async function lookupArtist(artistName) {
  const results = await itunesSearch(artistName);
  const matching = results.filter((r) => matchesArtist(r, artistName));
  const seen = new Set();
  const out = [];
  for (const r of matching) {
    const norm = normaliseResult(r);
    if (!norm) continue;
    if (seen.has(norm.sourceId)) continue;
    seen.add(norm.sourceId);
    out.push(norm);
  }
  out.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  return out;
}
