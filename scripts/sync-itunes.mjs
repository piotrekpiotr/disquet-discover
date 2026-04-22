#!/usr/bin/env node
/**
 * Daily per-artist release sync via the iTunes / Apple Music Search API.
 *
 * Why this exists (critical):
 *   The original daily pipeline only asked Discogs for new releases. Discogs
 *   is a hand-maintained catalogue — brand-new releases typically don't appear
 *   there for days or weeks after they drop on Apple Music / Bandcamp /
 *   Spotify. That meant same-day releases from artists we actively track
 *   (e.g. Purelink, Rainy Miller, Cinna Peyghamy) were simply invisible to
 *   /admin until Discogs got around to cataloging them.
 *
 *   Apple Music's public search API, in contrast, is updated the moment a
 *   label pushes a release. Walking our ARTISTS list once a day against that
 *   API guarantees we pick up same-day drops from anyone we monitor.
 *
 * What it does:
 *   For each artist in monitoring.mjs ARTISTS:
 *     1. Fetch that artist's recent albums + singles from iTunes.
 *     2. Keep only releases with releaseDate >= FRESH_SINCE (default: last
 *        14 days) to avoid drowning the admin with back catalogue.
 *     3. Skip anything already in data/recommendations.json (by id OR by
 *        case-insensitive artist|title match).
 *     4. Append as status="pending" so the curator vets it via /admin.
 *
 *   Output fields match the site's Recommendation type — cover image URL,
 *   Apple Music deep link, searchable fallback links for Bandcamp/Spotify/
 *   YouTube/SoundCloud, tags from iTunes primaryGenreName.
 *
 * Budgeting:
 *   ARTIST_LIMIT and MAX_NEW_TOTAL keep the run bounded. Per-artist we take
 *   at most one LP/EP and one single; across the whole run we stop at the
 *   global cap so the curator still gets a bite-sized batch to review.
 *
 * Rate limiting:
 *   iTunes doesn't publish an official per-minute quota, but we space calls
 *   ~200ms apart and bail politely on non-200 responses. In practice the
 *   script sails through ~200 artists in a couple of minutes.
 *
 * Safe to re-run:
 *   Idempotent. Re-running the same day adds zero duplicates because the
 *   dedupe check happens against the current file on disk every pass.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS } from "./monitoring.mjs";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +itunes";

// Only consider releases from the last N days. 14 days is enough to catch
// anything that dropped since the last daily run, with a generous safety
// margin if the workflow skipped a day. Increase to bootstrap a new artist
// with a slightly longer tail.
const FRESH_DAYS = Number(process.env.ITUNES_FRESH_DAYS || 14);
const FRESH_SINCE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - FRESH_DAYS);
  return d.toISOString().slice(0, 10);
})();

// Per-artist cap: one LP/EP + one single is plenty. The daily script isn't
// meant to back-populate a catalogue, only flag what's NEW.
const ARTIST_LIMIT = 2;

// Global safety cap. Spread across the full ARTISTS list, this is "how many
// new pending records can the curator realistically review in a sitting."
// Far more generous than sync-labels' cap because per-artist hits are
// higher-signal — the artist is already vetted to be on the list.
const MAX_NEW_TOTAL = Number(process.env.ITUNES_MAX_NEW_TOTAL || 30);

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function artworkLarge(url) {
  if (!url) return null;
  // iTunes returns a 100x100 thumbnail by default; swap the size segment for
  // 600x600 so the card / PDF export renders cleanly.
  return url.replace(/\/\d+x\d+(bb)?\./, "/600x600bb.");
}

function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
}

/**
 * Extract the label name from an iTunes `copyright` string.
 *
 * iTunes doesn't expose a `label` field on search results, but the copyright
 * line on most releases looks like:
 *   "℗ 2026 Fixed Abode"
 *   "© 2024 Other People Records"
 *   "2025 Warp Records Limited"
 * Stripping the year + ℗/© prefix gets us a reasonable label guess. This
 * is best-effort — enrich-labels-and-embeds runs later in the pipeline and
 * can correct it from Discogs when a match exists.
 */
function labelFromCopyright(copyright) {
  if (!copyright) return "";
  return copyright
    .replace(/[℗©]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickReleaseType(result) {
  const name = (result.collectionName || result.trackName || "").toLowerCase();
  if (/-\s*single$/i.test(result.collectionName || "")) return "single";
  if (/-\s*ep$/i.test(result.collectionName || "")) return "ep";
  if (result.trackCount && result.trackCount <= 3) return "single";
  if (result.trackCount && result.trackCount <= 6) return "ep";
  return "album";
}

function searchUrls(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=a`,
    spotify: `https://open.spotify.com/search/${q}`,
    soundcloud: `https://soundcloud.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

async function lookup(artist) {
  // attribute=artistTerm keeps the search scoped to the artist field, not
  // a fuzzy match across track/album titles. Crucial for short names like
  // "aya" or "LOG" that would otherwise drown in noise.
  //
  // entity=album returns RELEASE collections — LPs, EPs, AND singles-as-
  // collections (titled e.g. "Barrons Hotel - Single"). That's the canonical
  // "a new release came out" unit. Earlier versions of this script ran a
  // second entity=musicTrack pass to catch singles, but musicTrack returns
  // individual song records with different IDs/URLs, and iTunes catalogues
  // most new singles as collections already. The two passes were actually
  // creating a hole where singles fell through: the album pass filtered
  // them out, the track pass couldn't match them to release metadata.
  // Single pass, keep everything — simpler and catches every release type.
  const term = encodeURIComponent(artist);
  const url = `https://itunes.apple.com/search?term=${term}&entity=album&limit=25&media=music&attribute=artistTerm`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.results) ? json.results : [];
  } catch {
    return [];
  }
}

function normalizeArtist(a) {
  return (a || "").toLowerCase().trim();
}

/**
 * Split an iTunes artistName into its collaborator tokens.
 *
 * Why: labels credit joint releases with names like "Purelink & Rainy Miller"
 * or "Four Tet x Skrillex" or "Loraine James feat. Eden Samara". A strict
 * equality check on artistName would miss every single collab, which is
 * exactly how we missed the Purelink × Rainy Miller release. Splitting on
 * the common conjunctions / featuring markers lets us match each contributor
 * independently, so "Rainy Miller" matches any of the joint variants while
 * we still reject unrelated artists.
 *
 * Separators covered:
 *   &  ·  +  /  ,  ;  " x "  " vs "  " with "  " feat. "  " featuring "
 *
 * The list is deliberately narrow — we DON'T split on whitespace, so
 * multi-word artist names ("Floating Points", "96 Back") stay intact.
 */
function splitArtistCredits(artistName) {
  if (!artistName) return [];
  // Replace the compound separators with a single sentinel, then split once.
  const cleaned = artistName
    .replace(/\s+(?:feat\.?|featuring|ft\.?|vs\.?|with|x)\s+/gi, "|")
    .replace(/[,&/;·+]/g, "|");
  return cleaned
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function matchesArtist(result, wanted) {
  // Case-insensitive match against the full artistName OR any single
  // collaborator token parsed out of it. Rejects partial-string matches
  // (so "Rainy" won't match "Rainy Miller"); requires a whole-name hit.
  const wantedNorm = normalizeArtist(wanted);
  if (normalizeArtist(result.artistName) === wantedNorm) return true;
  for (const token of splitArtistCredits(result.artistName)) {
    if (normalizeArtist(token) === wantedNorm) return true;
  }
  return false;
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  const existingIds = new Set(items.map((it) => it.id));
  const existingKey = new Set(
    items.map(
      (it) => `${normalizeArtist(it.artist)}|${(it.title || "").toLowerCase()}`,
    ),
  );
  // Track Apple collectionIds we've already added THIS RUN so a collab
  // release triggered by two different tracked artists (e.g. Purelink AND
  // Rainy Miller both in ARTISTS) only creates one record.
  const addedCollectionIds = new Set();

  console.log(
    `[sync-itunes] scanning ${ARTISTS.length} artists for releases since ${FRESH_SINCE}`,
  );

  let addedTotal = 0;
  let hitCap = false;

  for (const artist of ARTISTS) {
    if (hitCap) break;
    let addedForArtist = 0;
    const newThisArtist = [];

    const results = await lookup(artist);
    // Keep strict artist matches only; then dedupe by collectionId.
    const mine = results.filter((r) => matchesArtist(r, artist));
    const seen = new Set();
    const unique = [];
    for (const r of mine) {
      const key = r.collectionId || r.trackId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(r);
    }
    unique.sort((a, b) =>
      (b.releaseDate || "").localeCompare(a.releaseDate || ""),
    );

    // Freshness gate — only recent drops qualify for the daily batch.
    const fresh = unique.filter(
      (r) => (r.releaseDate || "").slice(0, 10) >= FRESH_SINCE,
    );

    // Every fresh collection is a candidate — LP, EP, or single-as-collection.
    // ARTIST_LIMIT below keeps any one artist from filling the pool if they
    // drop a reissue pack with ten singles on the same day.
    for (const pick of fresh) {
      if (addedForArtist >= ARTIST_LIMIT) break;

      const rawTitle = pick.collectionName || pick.trackName || "";
      const title = cleanTitle(rawTitle);
      if (!title) continue;

      // For collab releases we want to preserve the full credited name
      // ("Purelink & Rainy Miller") rather than the single tracked artist
      // that triggered the hit. This way the site shows the real artist
      // string that appears on the release itself.
      const displayArtist = pick.artistName || artist;

      const dedupeKey = `${normalizeArtist(displayArtist)}|${title.toLowerCase()}`;
      if (existingKey.has(dedupeKey)) continue;
      // Also dedupe by Apple collectionId within this run so the same
      // collab isn't added twice when a second tracked artist hits it.
      const collectionId = pick.collectionId || pick.trackId;
      if (collectionId && addedCollectionIds.has(collectionId)) continue;

      const releaseDate = (pick.releaseDate || "").slice(0, 10);
      const art = artworkLarge(pick.artworkUrl100 || pick.artworkUrl60);
      const apple = (pick.collectionViewUrl || pick.trackViewUrl || "")
        .split("?")[0];
      const type = pickReleaseType(pick);
      const tag = (pick.primaryGenreName || "").toLowerCase();
      const s = searchUrls(displayArtist, title);

      let id = `${slugify(displayArtist)}-${slugify(title)}`.slice(0, 80);
      if (existingIds.has(id)) id = `${id}-it`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      existingKey.add(dedupeKey);
      if (collectionId) addedCollectionIds.add(collectionId);

      newThisArtist.push({
        id,
        type,
        artist: displayArtist,
        title,
        // Best-effort label parse from iTunes copyright. enrich-labels
        // runs later and can overwrite this with the Discogs canonical
        // form when a match exists.
        label: labelFromCopyright(pick.copyright),
        releaseDate: releaseDate || `${new Date().getUTCFullYear()}-01-01`,
        description: "",
        tags: tag ? [tag] : [],
        links: {
          apple,
          bandcamp: s.bandcamp,
          spotify: s.spotify,
          soundcloud: s.soundcloud,
          youtube: s.youtube,
        },
        embed: null,
        musicVideoUrl: null,
        status: "pending",
        approvedAt: null,
        coverImageUrl: art || null,
        cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
        pressMentions: [],
      });
      addedForArtist++;
      addedTotal++;

      if (addedTotal >= MAX_NEW_TOTAL) {
        hitCap = true;
        break;
      }
    }

    if (newThisArtist.length > 0) {
      items.push(...newThisArtist);
      console.log(
        `  ${artist}: +${newThisArtist.length} (${newThisArtist
          .map((r) => `${r.type}:${r.title}`)
          .join(", ")})`,
      );
      // Progressive save — if the run dies midway, we keep everything so far.
      items.sort((a, b) =>
        (b.releaseDate || "").localeCompare(a.releaseDate || ""),
      );
      await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
    }

    // polite spacing between artists
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    `[sync-itunes] done: +${addedTotal} new record(s)` +
      (hitCap ? ` (capped at ${MAX_NEW_TOTAL})` : "") +
      `. Pool now ${items.length} total.`,
  );
}

main().catch((e) => {
  console.error("[sync-itunes] failed:", e);
  process.exit(1);
});
