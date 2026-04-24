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
 * Extract release URLs from the Bandcamp search HTML. Dedupes, preserves
 * order. Bandcamp hosts two release URL shapes:
 *   - `https://{artist}.bandcamp.com/album/{slug}`  (EPs, albums,
 *     multi-track singles with a cover)
 *   - `https://{artist}.bandcamp.com/track/{slug}`  (single-track pages;
 *     Bandcamp shows a dedicated track page for each song, and for proper
 *     "A-side single" releases the `/track/...` URL IS the release — no
 *     album wrapper exists. Martyn's "Heavy Sound" single is this shape).
 *
 * Previously we only matched /album/, so singles were missed and fell back
 * to search URLs. Track URLs embed with `track=<id>` in the player URL
 * instead of `album=<id>`; the caller handles both shapes.
 */
function parseSearchResults(html) {
  const re = /https?:\/\/[a-z0-9-]+\.bandcamp\.com\/(?:album|track)\/[a-z0-9-]+/gi;
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

/** True when the release URL points at a single-track (standalone) page. */
function isTrackUrl(url) {
  return /\/track\/[a-z0-9-]+/i.test(url);
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
function parseAlbumPage(html, pageUrl) {
  // On a /track/ page we want the track's numeric id (and its embed URL
  // uses `track=<id>`). On an /album/ page we want album id (`album=<id>`).
  // Bandcamp emits BOTH inside any given album page (each track row shows
  // a track=... id), so we MUST pick the one that matches the URL type.
  const isTrack = pageUrl ? isTrackUrl(pageUrl) : false;
  let releaseId = null;
  let embedKind = "album";
  if (isTrack) {
    const idMatch = html.match(/track=(\d{5,})/);
    releaseId = idMatch?.[1] || null;
    embedKind = "track";
  } else {
    const idMatch = html.match(/album=(\d{5,})/);
    releaseId = idMatch?.[1] || null;
    embedKind = "album";
  }
  if (!releaseId) return null;

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

  // Track pages are always one track; don't parse a tracklist (there
  // isn't one), just report 1 so the height formula picks the minimum.
  const trackCount = isTrack ? 1 : parseTrackCount(html);

  return { releaseId, embedKind, title, artist, trackCount };
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
  // Previously hardcoded `item_type=a` (albums only). Drop the filter so
  // we also pick up track pages for singles — Martyn's "Heavy Sound" is
  // a /track/ page on martyn.bandcamp.com with no /album/ wrapper, and
  // this is the only way to resolve it.
  const searchUrl = `https://bandcamp.com/search?q=${q}`;

  let html;
  try {
    html = await fetchHtml(searchUrl);
  } catch {
    return null;
  }

  const allCandidates = parseSearchResults(html);
  // Prefer album URLs first (multi-track releases), fall back to track URLs.
  // For a single this ordering means we'd still prefer an album page that
  // packages the single if Bandcamp has one, and only use the standalone
  // track page when that's the only shape.
  const candidates = [
    ...allCandidates.filter((u) => !isTrackUrl(u)),
    ...allCandidates.filter((u) => isTrackUrl(u)),
  ].slice(0, 3);
  if (candidates.length === 0) return null;

  for (const releaseUrl of candidates) {
    await polite();
    let page;
    try {
      page = await fetchHtml(releaseUrl);
    } catch {
      continue;
    }
    const info = parseAlbumPage(page, releaseUrl);
    if (!info) continue;

    const aSim = tokenOverlap(artist, info.artist);
    const tSim = tokenOverlap(title, info.title);
    if (aSim < 0.55 || tSim < 0.55) continue; // false-match guard

    return {
      releaseId: info.releaseId,
      embedKind: info.embedKind, // "album" | "track"
      releaseUrl,
      verifiedArtist: info.artist,
      verifiedTitle: info.title,
      trackCount: info.trackCount,
    };
  }
  return null;
}

// ---------- main ----------

/**
 * True when links.bandcamp is unset or is still a search URL — i.e. we
 * haven't resolved a real album page yet and another Bandcamp lookup
 * would be useful.
 */
function linkIsSearchOrMissing(url) {
  if (!url) return true;
  return url.includes("/search");
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let foundEmbed = 0;
  let foundLinkOnly = 0;
  let missed = 0;
  let skipped = 0;

  for (const item of items) {
    const needsEmbed = !item.embed;
    const needsLink = linkIsSearchOrMissing(item.links?.bandcamp);

    // Nothing to do: this record already has an embed AND a real Bandcamp
    // album URL. Previously we `continue`d on the embed check alone, which
    // meant records that got an Apple/Deezer embed first never had their
    // Bandcamp link upgraded from the seed search URL.
    if (!needsEmbed && !needsLink) {
      skipped++;
      continue;
    }

    process.stdout.write(`${item.artist} - ${item.title}: `);
    try {
      const bc = await findBandcampAlbum(item);
      if (bc) {
        // Only write an embed when the record doesn't already have one
        // from a higher-priority source (Apple / Deezer). A record with
        // an Apple embed and a Bandcamp link is exactly the intended
        // state after this runs.
        if (needsEmbed) {
          // Track pages use a fixed, short player — Bandcamp itself
          // emits height=120 for `track=<id>` single-track embeds, and
          // the track-count-based formula for albums is irrelevant
          // (there's only one track). Albums keep the responsive
          // `size=large/tracklist=true` template sized to the parsed
          // track count.
          const isTrackEmbed = bc.embedKind === "track";
          const height = isTrackEmbed ? 120 : computeBandcampHeight(bc.trackCount);
          item.embed = {
            provider: "bandcamp",
            src: isTrackEmbed
              ? `https://bandcamp.com/EmbeddedPlayer/track=${bc.releaseId}` +
                `/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/`
              : `https://bandcamp.com/EmbeddedPlayer/album=${bc.releaseId}` +
                `/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=true/artwork=small/transparent=true/`,
            height,
          };
          foundEmbed++;
        } else {
          foundLinkOnly++;
        }
        // Upgrade the stored link if it was a search URL (or missing).
        if (linkIsSearchOrMissing(item.links?.bandcamp)) {
          item.links = { ...(item.links || {}), bandcamp: bc.releaseUrl };
        }
        const kindTag = bc.embedKind === "track" ? "track" : "album";
        const tag = needsEmbed
          ? `bandcamp:${kindTag}=${bc.releaseId} ${bc.trackCount ? `(${bc.trackCount} tracks)` : ""}`
          : `link-only bandcamp:${kindTag}=${bc.releaseId}`;
        console.log(
          `${tag} (${bc.verifiedArtist} - ${bc.verifiedTitle})`,
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

  console.log(
    `\nBandcamp backfill: embed=${foundEmbed}, link-only=${foundLinkOnly}, missed=${missed}, skipped=${skipped}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
