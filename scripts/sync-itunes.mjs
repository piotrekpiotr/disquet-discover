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

/**
 * Call the iTunes search API with retry + backoff.
 *
 * Why retry matters: on 2026-04-22 a workflow run silently produced zero
 * new pending records despite Purelink, Cinna Peyghamy, and ~10 other
 * tracked artists all shipping brand-new releases. Running the same
 * script locally the same hour found every one of them. The most likely
 * explanation is that GitHub-hosted runner IPs hit a transient iTunes
 * rate-limit / 403 burst, and the old `if (!res.ok) return []` swallowed
 * every failed artist without a peep — the workflow's `continue-on-error`
 * then masked the 249-for-249 failure. End result: a whole day of
 * releases missed from the admin panel.
 *
 * Hardening:
 *   - Log every non-200 so the Actions log has a paper trail.
 *   - Retry up to RETRIES times with exponential backoff + jitter.
 *     iTunes doesn't publish a rate cap, but anecdotal reports put it
 *     at ~20 req/sec per IP; we pace at 200ms and give failures space.
 *   - On final failure, throw rather than silently return []. The caller
 *     wraps in try/catch and continues to the next artist, but the
 *     failure is counted and printed in the run summary so a catastrophic
 *     pass-through is visible instead of invisible.
 */
const RETRIES = 3;
async function lookup(artist) {
  // attribute=artistTerm keeps the search scoped to the artist field, not
  // a fuzzy match across track/album titles. Crucial for short names like
  // "aya" or "LOG" that would otherwise drown in noise.
  //
  // entity=album returns RELEASE collections — LPs, EPs, AND singles-as-
  // collections (titled e.g. "Barrons Hotel - Single"). That's the canonical
  // "a new release came out" unit.
  const term = encodeURIComponent(artist);
  const url = `https://itunes.apple.com/search?term=${term}&entity=album&limit=25&media=music&attribute=artistTerm`;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const json = await res.json();
        return Array.isArray(json.results) ? json.results : [];
      }
      lastErr = new Error(`iTunes ${res.status} for ${artist}`);
      // 403 / 429 / 5xx: back off and retry. Progressive: 0.6s, 1.8s, 5.4s
      // + a little jitter to avoid synchronised retries across a batch.
      const delay = 600 * Math.pow(3, attempt - 1) + Math.random() * 400;
      console.log(
        `  [retry ${attempt}/${RETRIES}] ${artist}: ${res.status}, waiting ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    } catch (e) {
      lastErr = e;
      const delay = 600 * Math.pow(3, attempt - 1) + Math.random() * 400;
      console.log(
        `  [retry ${attempt}/${RETRIES}] ${artist}: ${e.message}, waiting ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error(`iTunes lookup failed for ${artist}`);
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
  // Track artists where the lookup hard-failed after retries, so we can
  // surface the count in the run summary. A non-zero failure count is a
  // loud signal that CI ran against a throttled IP and the run is
  // suspect — far better than pretending all 249 artists simply had no
  // new releases.
  const lookupFailures = [];

  for (const artist of ARTISTS) {
    if (hitCap) break;
    let addedForArtist = 0;
    const newThisArtist = [];

    let results;
    try {
      results = await lookup(artist);
    } catch (e) {
      lookupFailures.push({ artist, error: e.message });
      console.log(`  ${artist}: LOOKUP FAILED after retries (${e.message})`);
      continue;
    }
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
  if (lookupFailures.length > 0) {
    console.log(
      `[sync-itunes] WARNING: ${lookupFailures.length}/${ARTISTS.length} ` +
        `artists failed lookup after retries:`,
    );
    for (const f of lookupFailures.slice(0, 20)) {
      console.log(`   - ${f.artist}: ${f.error}`);
    }
    if (lookupFailures.length > 20) {
      console.log(`   ...and ${lookupFailures.length - 20} more`);
    }
    // Catastrophic threshold: more than 30% of artists failed. Almost
    // always this means the runner's IP got throttled/blocked by Apple
    // and every subsequent artist is a false negative. Exit non-zero so
    // the workflow's `continue-on-error` logs a red ✗ on the Actions
    // page — the curator sees it on the next visit and can manually
    // rerun from their Mac, which uses a residential IP that iTunes
    // almost never rate-limits.
    const failureRate = lookupFailures.length / ARTISTS.length;
    if (failureRate > 0.3) {
      console.error(
        `[sync-itunes] ABORT: ${Math.round(failureRate * 100)}% of artists ` +
          `failed lookup — treating the run as suspect. Exiting non-zero.`,
      );
      process.exit(2);
    }
  }
}

main().catch((e) => {
  console.error("[sync-itunes] failed:", e);
  process.exit(1);
});
