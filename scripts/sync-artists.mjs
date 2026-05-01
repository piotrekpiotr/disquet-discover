#!/usr/bin/env node
/**
 * Per-artist release sync — the "what did the artists I actually track ship
 * in the last two weeks" pass. Replaces the old sync-itunes.mjs, which had
 * three design problems this rewrite fixes:
 *
 *   1. SINGLE SOURCE. Old script only asked iTunes. When Apple's edge
 *      decided the GitHub runner IP looked like a bot (which happened on
 *      2026-04-23), the whole daily pool got nothing from the artist pass.
 *      This script tries iTunes first, then falls back to Deezer per-artist
 *      when iTunes returns nothing or throws. Deezer's infra is different
 *      enough that the two sources almost never fail together.
 *
 *   2. HARD CAPS. Old script had MAX_NEW_TOTAL=30 and ARTIST_LIMIT=2. On
 *      a busy Friday it would stop scanning halfway through the list, so
 *      artists at the bottom of ARTISTS got starved. This script scans
 *      EVERY artist in the pool (base + curator extras) and records EVERY
 *      fresh release each source reports. The curator vets via /admin;
 *      that's where throttling belongs, not here.
 *
 *   3. ABORT-ON-FAILURE. Old script would exit non-zero if >30% of
 *      artists failed lookup, preventing the commit step from shipping
 *      whatever partial progress it had. This script never aborts — it
 *      logs per-source stats and always exits 0 so downstream steps ship
 *      what they got. The workflow's run-health summary handles "was this
 *      run a real zero?" as a data question, not a control-flow one.
 *
 * Output: appends status="pending" records to data/recommendations.json,
 * deduped by id and by case-insensitive artist|title. Also writes a
 * sidecar data/.sync-artists-stats.json the workflow can read for its
 * health summary (gitignored, ephemeral).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS as BASE_ARTISTS } from "./monitoring.mjs";
import { fetchMonitoringExtras, mergeUnique } from "./fetch-extras.mjs";
import * as itunes from "./sources/itunes.mjs";
import * as deezer from "./sources/deezer.mjs";
import * as lastfmReleases from "./sources/lastfm-releases.mjs";

const FILE = path.resolve("data/recommendations.json");
const STATS_FILE = path.resolve("data/.sync-artists-stats.json");

// Only consider releases from the last N days. 14 days is enough to catch
// anything that dropped since the last daily run, with a generous safety
// margin if the workflow skipped a day or two.
const FRESH_DAYS = Number(process.env.SYNC_FRESH_DAYS || 14);
const FRESH_SINCE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - FRESH_DAYS);
  return d.toISOString().slice(0, 10);
})();

// Spacing between per-artist requests to each source. Each source has its
// own retry+backoff on error; this is just a politeness sleep to keep the
// average rate well below any published limit. ~250 artists × 250ms = 62s
// of pacing per source, which is trivial inside a 6-hour job budget.
const PER_ARTIST_SPACING_MS = 250;

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function normaliseArtist(a) {
  return (a || "").toLowerCase().trim();
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
 * Run all sources for a single artist and return the union of their
 * results, deduped across sources by (artist|title). Order matters: iTunes
 * runs first, so its richer metadata (label, tag, Apple deep link) wins on
 * ties with Deezer.
 *
 * Per-source failures are swallowed here — we want "artist scanned" to
 * mean "at least one source answered", not "every source answered". Stats
 * are recorded so the workflow can tell how bad a day was.
 */
async function scanArtist(artist, stats) {
  /** @type {import("./sources/itunes.mjs").Release[]} */
  const collected = [];
  const seenKey = new Set();

  const runSource = async (name, source) => {
    stats[name].attempted++;
    try {
      const releases = await source.lookupArtist(artist);
      stats[name].succeeded++;
      if (releases.length > 0) stats[name].nonEmpty++;
      for (const r of releases) {
        const key = `${normaliseArtist(r.artist)}|${r.title.toLowerCase()}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        collected.push(r);
      }
    } catch (e) {
      stats[name].failed++;
      const shortMsg = (e && e.message) || "unknown";
      stats[name].failures.push({ artist, error: shortMsg });
    }
  };

  // iTunes is primary because it tends to have richer metadata (label
  // guess via copyright, genre, Apple Music deep link). Deezer fills the
  // gaps when Apple 403s or returns nothing. Last.fm is the third leg —
  // it scrapes the artist page's "Latest release" pointer (sourced from
  // MusicBrainz inside Last.fm's render layer), which sometimes catches
  // niche / Bandcamp-only releases neither Apple nor Deezer indexes. We
  // run Last.fm UNCONDITIONALLY (not as a fallback) because its release
  // is often DIFFERENT from what iTunes returned — a Bandcamp-exclusive
  // EP alongside an Apple-listed single, say. The dedup-by-(artist|title)
  // step in runSource keeps duplicates from sneaking in when the same
  // release is on multiple sources.
  await runSource("itunes", itunes);
  if (collected.length === 0) {
    await runSource("deezer", deezer);
  }
  await runSource("lastfm", lastfmReleases);

  return collected;
}

/**
 * Turn a normalised Release (from any source) into the Recommendation shape
 * that the rest of the site expects. Search URLs are precomputed for
 * bandcamp/spotify/youtube/soundcloud so the card always has *some*
 * outbound link even when a source doesn't include one.
 */
function toRecommendation(release, existingIds) {
  const s = searchUrls(release.artist, release.title);
  let id = `${slugify(release.artist)}-${slugify(release.title)}`.slice(0, 80);
  // Collisions happen when two artists release an eponymous track. Append
  // a two-letter source tag so we don't silently replace one with the
  // other. -ap = apple/itunes, -dz = deezer, -lf = lastfm.
  const tag =
    release.source === "itunes"
      ? "ap"
      : release.source === "deezer"
        ? "dz"
        : "lf";
  if (existingIds.has(id)) id = `${id}-${tag}`;
  if (existingIds.has(id)) return null; // double collision — give up, try next release

  const links = {
    bandcamp: s.bandcamp,
    spotify: s.spotify,
    soundcloud: s.soundcloud,
    youtube: s.youtube,
  };
  if (release.source === "itunes" && release.externalUrl) {
    links.apple = release.externalUrl;
  }
  if (release.source === "deezer" && release.externalUrl) {
    links.deezer = release.externalUrl;
  }
  // Last.fm doesn't carry a public-streaming URL we want to surface.
  // The card falls back to search URLs for every service; the next
  // backfill-embeds pass will populate links.apple / links.deezer when
  // iTunes or Deezer eventually indexes the release.

  return {
    id,
    type: release.releaseType,
    artist: release.artist,
    title: release.title,
    label: release.label || "",
    releaseDate: release.releaseDate,
    description: "",
    tags: release.tag ? [release.tag] : [],
    links,
    embed: null,
    musicVideoUrl: null,
    status: "pending",
    approvedAt: null,
    coverImageUrl: release.artworkUrl || null,
    cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
    pressMentions: [],
  };
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  const existingIds = new Set(items.map((it) => it.id));
  const existingKey = new Set(
    items.map(
      (it) => `${normaliseArtist(it.artist)}|${(it.title || "").toLowerCase()}`,
    ),
  );
  // Track (source, sourceId) we've already added this run so one collab
  // release triggered by multiple tracked artists only creates one record.
  const addedSourceIds = new Set();

  // Merge hardcoded ARTISTS with curator-added extras from /api/monitoring-extras.
  const extras = await fetchMonitoringExtras();
  const ARTISTS = mergeUnique(BASE_ARTISTS, extras.artists);

  console.log(
    `[sync-artists] scanning ${ARTISTS.length} artists ` +
      `(${BASE_ARTISTS.length} base + ${ARTISTS.length - BASE_ARTISTS.length} curator-added) ` +
      `for releases since ${FRESH_SINCE}`,
  );

  const stats = {
    itunes: { attempted: 0, succeeded: 0, failed: 0, nonEmpty: 0, failures: [] },
    deezer: { attempted: 0, succeeded: 0, failed: 0, nonEmpty: 0, failures: [] },
    lastfm: { attempted: 0, succeeded: 0, failed: 0, nonEmpty: 0, failures: [] },
    addedTotal: 0,
    artistsWithAdditions: 0,
  };

  // Run per-artist scans CONCURRENTLY in batches. Sequential 262
  // artists × ~1-1.5s each was the largest single contributor to the
  // CI runtime; bumping to 6 concurrent drops it from ~5 min to ~50s
  // worst case. Concurrency cap is conservative because each scan
  // inside scanArtist() fans out to iTunes + Deezer + Last.fm —
  // 6 parallel × 3 sources = 18 in-flight HTTP calls, well below
  // any source's published per-key rate limit and, crucially, below
  // the threshold where iTunes' edge starts 429ing the GitHub runner
  // IP range. The 250ms intra-batch pacing is preserved so we don't
  // hammer any one source within a tight window.
  const CONCURRENCY = 6;
  const queue = [...ARTISTS];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const artist = queue.shift();
      if (!artist) return;
      const releases = await scanArtist(artist, stats);
      // Freshness gate at the orchestrator so each source stays dumb.
      const fresh = releases.filter((r) => r.releaseDate >= FRESH_SINCE);
      let addedForArtist = 0;
      for (const release of fresh) {
        const key = `${normaliseArtist(release.artist)}|${release.title.toLowerCase()}`;
        if (existingKey.has(key)) continue;
        const sourceKey = `${release.source}:${release.sourceId}`;
        if (addedSourceIds.has(sourceKey)) continue;
        const rec = toRecommendation(release, existingIds);
        if (!rec) continue;
        existingIds.add(rec.id);
        existingKey.add(key);
        addedSourceIds.add(sourceKey);
        items.push(rec);
        addedForArtist++;
        stats.addedTotal++;
      }
      if (addedForArtist > 0) {
        stats.artistsWithAdditions++;
        console.log(
          `  ${artist}: +${addedForArtist} [${fresh
            .slice(0, addedForArtist)
            .map((r) => `${r.source}:${r.releaseType}:${r.title}`)
            .join(", ")}]`,
        );
        // Progressive save — if the job dies halfway we keep
        // everything so far. Sort + write is atomic enough that the
        // concurrent workers don't corrupt each other (Node fs is
        // single-threaded; the worst case is interleaved writes
        // resolving to the same array snapshot, which is fine).
        items.sort((a, b) =>
          (b.releaseDate || "").localeCompare(a.releaseDate || ""),
        );
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
      }
      await new Promise((r) => setTimeout(r, PER_ARTIST_SPACING_MS));
    }
  });
  await Promise.all(workers);

  // Final summary
  console.log(
    `[sync-artists] done: +${stats.addedTotal} record(s) across ` +
      `${stats.artistsWithAdditions} artist(s). ` +
      `iTunes: ${stats.itunes.succeeded}/${stats.itunes.attempted} ok ` +
      `(${stats.itunes.nonEmpty} had releases, ${stats.itunes.failed} failed). ` +
      `Deezer fallback: ${stats.deezer.attempted} attempted, ` +
      `${stats.deezer.succeeded} ok, ${stats.deezer.failed} failed. ` +
      `Last.fm: ${stats.lastfm.succeeded}/${stats.lastfm.attempted} ok ` +
      `(${stats.lastfm.nonEmpty} had releases, ${stats.lastfm.failed} failed).`,
  );

  if (stats.itunes.failed > 0) {
    console.log(
      `  iTunes failures (first 10): ${stats.itunes.failures
        .slice(0, 10)
        .map((f) => `${f.artist}:${f.error}`)
        .join(" | ")}`,
    );
  }

  // Workflow sidecar — lets the run-health step read numbers without
  // parsing logs. Gitignored via .gitignore; the commit step also rm -f's
  // this before diffing to be doubly safe.
  try {
    const total = ARTISTS.length;
    await fs.writeFile(
      STATS_FILE,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          artistsScanned: total,
          addedTotal: stats.addedTotal,
          artistsWithAdditions: stats.artistsWithAdditions,
          itunes: {
            attempted: stats.itunes.attempted,
            succeeded: stats.itunes.succeeded,
            failed: stats.itunes.failed,
            nonEmpty: stats.itunes.nonEmpty,
            failureRate: total ? stats.itunes.failed / total : 0,
          },
          deezer: {
            attempted: stats.deezer.attempted,
            succeeded: stats.deezer.succeeded,
            failed: stats.deezer.failed,
            nonEmpty: stats.deezer.nonEmpty,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // non-fatal
  }
}

main().catch((e) => {
  console.error("[sync-artists] failed:", e);
  // Intentionally exit 0 even on catastrophic crash — downstream Discogs
  // + media scans still deserve a chance to ship their progress. The
  // workflow's run-health step handles "nothing shipped" messaging.
  process.exit(0);
});
