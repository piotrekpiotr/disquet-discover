/**
 * Bandcamp label-discography source. Closes the structural gap that
 * sync-labels.mjs (Discogs-only) leaves: Discogs is community-edited
 * and lags on digital + pre-order releases by weeks or months. The
 * AD 93 / GB-Herzsprung miss on 2026-04-30 was the catalyst — the
 * release was already up as a pre-order on https://ad93.bandcamp.com
 * (release date Aug 2026) but Discogs hadn't catalogued it. Same
 * pattern as the Jump Source / NAFF case earlier this year.
 *
 * Mechanism:
 *   Bandcamp ships a public mobile-app API that returns a label's
 *   FULL discography sorted by release date, including pre-orders:
 *
 *     GET https://bandcamp.com/api/mobile/22/band_details?band_id=<id>
 *       → { id, name, bandcamp_url, discography: [
 *             { item_id, item_type ("album"/"track"),
 *               artist_name, band_name, title, art_id,
 *               release_date "21 Aug 2026 00:00:00 GMT",
 *               band_id (artist's band_id, useful elsewhere) }, …
 *         ] }
 *
 *   No auth, no rate-limit observed at our volume (<100 labels). The
 *   `band_id` of a label is the same kind of identifier as a band
 *   band_id — Bandcamp treats labels as a flavour of band.
 *
 * Discoverability:
 *   To query the API we need each label's band_id. We maintain a
 *   curator-managed map in monitoring.mjs keyed by label name. For
 *   labels not in the map this source quietly skips them — no
 *   regression vs. Discogs-only behaviour. A separate
 *   scripts/discover-bandcamp-band-ids.mjs helper probes each label
 *   automatically and prints suggested map entries for the curator
 *   to copy in.
 *
 * Output shape:
 *   findLabelReleases(labelName, bandId) → array of normalised
 *   Release objects matching scripts/sources/itunes.mjs's contract,
 *   so the orchestrator (sync-labels.mjs) can dedupe and merge them
 *   alongside Discogs results without special-casing.
 */

const API_BASE = "https://bandcamp.com/api/mobile/22/band_details";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// "21 Aug 2026 00:00:00 GMT" → "2026-08-21". Returns "" on parse
// failure so downstream filters drop the item rather than
// propagating a bad date.
function parseBandcampDate(s) {
  if (!s) return "";
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Build the public Bandcamp release URL using the artist's band-page
 * subdomain. Returns null when the data is incomplete (rare).
 *
 * Bandcamp's mobile-API response contains `band_id` for each release
 * but NOT the artist's subdomain — to construct the URL we'd need a
 * second band_details lookup per artist. To avoid that fan-out, we
 * fall back to a Bandcamp item-page URL keyed on item_id, which
 * Bandcamp's web layer redirects to the canonical
 * artist-subdomain.bandcamp.com URL automatically.
 */
function bandcampItemUrl(item) {
  if (!item?.item_id) return null;
  // Bandcamp's "open in browser" deeplink form. It resolves to the
  // proper /album/ or /track/ canonical URL on first hit.
  const kind = item.item_type === "t" || item.item_type === "track"
    ? "track"
    : "album";
  return `https://bandcamp.com/${kind}/${item.item_id}`;
}

/**
 * Pull the label's discography. `bandId` is the label's numeric
 * Bandcamp band_id. Returns [] on any error so sync-labels can
 * keep running without bandcamp data.
 */
export async function fetchLabelDiscography(bandId) {
  if (!bandId || typeof bandId !== "number") return [];
  try {
    const r = await fetch(`${API_BASE}?band_id=${bandId}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) {
      console.log(`[bandcamp-label] band_id=${bandId} -> ${r.status}`);
      return [];
    }
    const j = await r.json();
    if (!Array.isArray(j?.discography)) return [];
    return j.discography;
  } catch (e) {
    console.log(`[bandcamp-label] band_id=${bandId} fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Public API: pull a label's recent releases as normalised Release
 * objects, ready to merge into the recommendations pipeline.
 *
 * Returns shape: [{
 *   source: "bandcamp-label",
 *   sourceId: <bandcamp item_id, stable+unique>,
 *   artist, title,
 *   releaseType: "album" | "track",
 *   releaseDate: "YYYY-MM-DD",
 *   externalUrl: bandcamp URL,
 *   artworkUrl: bcbits art URL,
 *   label: <labelName as passed in>,
 *   tag: "",
 * }, …]
 *
 * The labelName is passed back so the orchestrator can populate the
 * recommendation's `label` field without a second lookup. Artwork
 * URL is constructed from `art_id` using Bandcamp's CDN pattern
 * (`a<id>_10.jpg` is the largest standard size).
 */
export async function findLabelReleases(labelName, bandId) {
  const items = await fetchLabelDiscography(bandId);
  const out = [];
  for (const it of items) {
    const artist = (it.artist_name || it.band_name || "").trim();
    const title = (it.title || "").trim();
    if (!artist || !title) continue;
    const releaseDate = parseBandcampDate(it.release_date);
    if (!releaseDate) continue;
    out.push({
      source: "bandcamp-label",
      // item_id is unique across all of Bandcamp; serves as a stable
      // dedup key across runs without needing artist+title fuzzy
      // matching at the source level.
      sourceId: String(it.item_id),
      artist,
      title,
      releaseType: it.item_type === "t" || it.item_type === "track"
        ? "track"
        : "album",
      releaseDate,
      externalUrl: bandcampItemUrl(it),
      artworkUrl: it.art_id
        ? `https://f4.bcbits.com/img/a${it.art_id}_10.jpg`
        : null,
      label: labelName,
      tag: "",
    });
  }
  return out;
}
