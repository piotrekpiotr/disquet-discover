#!/usr/bin/env node
/**
 * Tier-3 embed backfill via Bandcamp. Runs after iTunes + Deezer have had
 * their shot and only processes records still without an `embed`.
 *
 * Why Bandcamp is worth the effort despite having no public API:
 *   - Many of the underground leftfield releases we track are Bandcamp-only
 *     (private-press cassettes, microlabel digital, pre-release white labels),
 *     so Apple/Deezer/Spotify won't have them.
 *   - Bandcamp's own iframe player is arguably the best for this catalog:
 *     full tracklist, artist-controlled UI, longer previews than Deezer/Spotify.
 *
 * How it works (pure fetch + regex, no dependencies):
 *
 *   1. Search https://bandcamp.com/search?q=<artist title>&item_type=a
 *      The search results page is server-rendered HTML with album URLs in
 *      the form https://<artist>.bandcamp.com/album/<slug>.
 *   2. For each of the top few results, fetch the album page. Bandcamp emits
 *      a <meta property="og:video" content="...EmbeddedPlayer/v=2/album=ID/..."/>
 *      on every album page, which gives us the numeric album_id we need for
 *      the embed URL. Same page has <meta property="og:title"> and og:site_name
 *      for verification.
 *   3. Verify with token-overlap against our record's artist + title (>=0.55
 *      on both; slightly looser than other tiers because Bandcamp artist pages
 *      sometimes append label/location to the og:title). Skip if not verified.
 *   4. Write embed { provider: "bandcamp", src: embedUrl, height: 470 } and
 *      links.bandcamp = album URL.
 *
 * Risk mitigations:
 *   - Desktop browser User-Agent (curl/Node defaults get flagged).
 *   - 1500ms polite delay between every Bandcamp request.
 *   - Two-stage verification (search hit + og-tag cross-check) keeps false
 *     matches out of the dataset.
 *   - Try at most 3 album candidates per record to bound network load.
 *
 * Progressive save on every record.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");

// Bandcamp serves slightly different HTML (and is more lenient) when the UA
// looks like a browser. Keep this realistic, not a custom string.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DELAY_MS = 1500;

// ---------- utilities (same shape as backfill-embeds.mjs) ----------

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function stripDiscogsSuffix(name) {
  return (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

function tokenOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

async function polite() {
  await new Promise((r) => setTimeout(r, DELAY_MS));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---------- Bandcamp search + verify ----------

/**
 * Extract album URLs from the Bandcamp search HTML. Dedupes, preserves order.
 * Format is always `https://{artist}.bandcamp.com/album/{slug}` (or a custom
 * domain, rare - those still work fine if present).
 */
function parseSearchResults(html) {
  const re = /https?:\/\/[a-z0-9-]+\.bandcamp\.com\/album\/[a-z0-9-]+/gi;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Parse an album page for the numeric album_id (for the embed URL) plus the
 * album title and artist name (for verification).
 *
 * Bandcamp's HTML quirks - discovered by probing real pages, NOT documented:
 *   - `og:video` content is sometimes absent; only `og:video:type/height/width`
 *     get emitted. Can't rely on that tag alone.
 *   - The numeric album ID is always inline in the page though, as part of
 *     the site's own embed iframe: look for the first `album=\d+` substring.
 *   - `og:title` format is "<title>, by <artist>" (comma + "by", NOT pipe).
 *   - `og:site_name` is the LABEL's Bandcamp page name, not the artist - so
 *     we can't use it as an artist cross-check on label pages like
 *     westmineral.bandcamp.com (would say "West Mineral Ltd.").
 */
function parseAlbumPage(html) {
  // Album ID: any `album=<digits>` in the HTML. First hit is the canonical
  // one (appears in the page's own embed iframe URL).
  const idMatch = html.match(/album=(\d{5,})/);
  const albumId = idMatch?.[1];
  if (!albumId) return null;

  // og:title: "<title>, by <artist>"
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );

  let title = "";
  let artist = "";
  if (ogTitle) {
    const raw = ogTitle[1];
    const byIdx = raw.lastIndexOf(", by ");
    if (byIdx > 0) {
      title = raw.slice(0, byIdx).trim();
      artist = raw.slice(byIdx + 5).trim();
    } else {
      title = raw.trim();
    }
  }

  const trackCount = parseTrackCount(html);

  return { albumId, title, artist, trackCount };
}

/**
 * Extract the number of tracks on a Bandcamp album page. Used to size the
 * embed iframe — a 3-track EP and a 16-track double LP need very different
 * heights on the `size=large` player, and a fixed value either clips the
 * tracklist (too short) or leaves a dead grey band under it (too tall).
 *
 * Three signals, tried in order of reliability:
 *   1. JSON-LD `numberOfItems` — Bandcamp emits schema.org MusicAlbum markup
 *      on most album pages; this is the cleanest number.
 *   2. `trackinfo: [ ... ]` — Bandcamp's own player bootstrap data. Count
 *      the objects inside the array by `"track_num"` occurrences (safer
 *      than matching the array literal itself, which may break across
 *      newlines).
 *   3. `<tr class="track_row_view">` — rendered tracklist rows in the HTML.
 *      Last resort; Bandcamp occasionally lazy-renders these, but it's a
 *      useful backstop.
 *
 * Returns null if nothing parseable — the caller falls back to the default
 * height rather than guessing.
 */
function parseTrackCount(html) {
  // (1) JSON-LD
  const ld = html.match(/"numberOfItems"\s*:\s*(\d+)/);
  if (ld) {
    const n = Number(ld[1]);
    if (Number.isFinite(n) && n > 0 && n < 200) return n;
  }
  // (2) trackinfo bootstrap — count "track_num" keys inside the blob
  const ti = html.match(/trackinfo\s*:\s*\[([\s\S]*?)\]/);
  if (ti) {
    const hits = ti[1].match(/"track_num"\s*:/g);
    if (hits && hits.length > 0) return hits.length;
  }
  // (3) rendered DOM
  const rows = html.match(/<tr[^>]*class="[^"]*track_row_view[^"]*"/g);
  if (rows && rows.length > 0) return rows.length;
  return null;
}

/**
 * Compute an appropriate iframe height for Bandcamp's `size=large` player
 * given a track count. Formula was calibrated against a few real embeds:
 *
 *   3 tracks →  370px     7 tracks → 470px     12 tracks → 610px
 *   5 tracks →  420px    10 tracks → 540px     20 tracks → 830px
 *
 * Which is roughly `300 + 25 * tracks`, clamped into a sane range so one
 * outlier (a 40-track DJ mix or a label compilation) doesn't produce an
 * absurdly tall card. Values outside the clamp are still playable — the
 * user just scrolls inside the iframe to reach the bottom of the
 * tracklist.
 *
 * NOTE: this assumes the `artwork=small` + `tracklist=true` template used
 * by this script. If the curator pastes a different Bandcamp iframe via
 * EmbedPicker (which might use a larger cover or a different layout), the
 * pasted height wins — that path goes through parseIframeBlob, not here.
 */
function computeBandcampHeight(trackCount) {
  if (!trackCount) return 470; // default for unknown — one-size safe-ish
  const raw = 300 + 25 * trackCount;
  return Math.max(350, Math.min(raw, 820));
}

async function findBandcampAlbum(item) {
  const artist = stripDiscogsSuffix(item.artist);
  const title = item.title;
  const q = encodeURIComponent(`${artist} ${title}`);
  const searchUrl = `https://bandcamp.com/search?q=${q}&item_type=a`;

  let html;
  try {
    html = await fetchHtml(searchUrl);
  } catch {
    return null;
  }

  const candidates = parseSearchResults(html).slice(0, 3);
  if (candidates.length === 0) return null;

  for (const albumUrl of candidates) {
    await polite();
    let page;
    try {
      page = await fetchHtml(albumUrl);
    } catch {
      continue;
    }
    const info = parseAlbumPage(page);
    if (!info) continue;

    const aSim = tokenOverlap(artist, info.artist);
    const tSim = tokenOverlap(title, info.title);
    if (aSim < 0.55 || tSim < 0.55) continue; // false-match guard

    return {
      albumId: info.albumId,
      albumUrl,
      verifiedArtist: info.artist,
      verifiedTitle: info.title,
      trackCount: info.trackCount,
    };
  }
  return null;
}

// ---------- main ----------

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let found = 0;
  let missed = 0;

  for (const item of items) {
    if (item.embed) continue;

    process.stdout.write(`${item.artist} - ${item.title}: `);
    try {
      const bc = await findBandcampAlbum(item);
      if (bc) {
        const height = computeBandcampHeight(bc.trackCount);
        item.embed = {
          provider: "bandcamp",
          // size=large + artwork=small + tracklist=true. Height is sized
          // per-record from the track count we parsed out of the album
          // page, so a 3-track EP gets ~375px and a 16-track album gets
          // ~700px without either clipping the tracklist or leaving a
          // dead band under it.
          src:
            `https://bandcamp.com/EmbeddedPlayer/album=${bc.albumId}` +
            `/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=true/artwork=small/transparent=true/`,
          height,
        };
        // Upgrade the stored link if it was a search URL.
        if (!item.links.bandcamp || item.links.bandcamp.includes("/search")) {
          item.links = { ...item.links, bandcamp: bc.albumUrl };
        }
        found++;
        console.log(
          `bandcamp:${bc.albumId} ${bc.trackCount ? `(${bc.trackCount} tracks, ${height}px)` : `(${height}px)`} (${bc.verifiedArtist} - ${bc.verifiedTitle})`,
        );
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
      } else {
        missed++;
        console.log("no match");
      }
    } catch (e) {
      missed++;
      console.log(`err (${e.message})`);
    }
    await polite();
  }

  console.log(`\nBandcamp backfill: found=${found}, missed=${missed}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
