#!/usr/bin/env node
/**
 * Upgrade `links.spotify` from "open.spotify.com/search/…" to a real album
 * URL, using the Spotify Web API via Client Credentials auth.
 *
 * Why this exists:
 *   sync-artists / sync-labels default `links.spotify` to a search URL
 *   because the release-discovery sources (iTunes, Deezer, Discogs) don't
 *   carry a Spotify album ID. That search URL "works" — it opens the
 *   Spotify web player at a search-results page — but it's one click short
 *   of what the visitor wanted, and the ServiceLink component can't build
 *   a `spotify:album:<id>` deep link from a search URL, so tapping the
 *   Spotify row on a record card just opens search in the browser instead
 *   of the album in the native app.
 *
 *   With the real album URL stored, buildAppUrl() (src/lib/music-links.ts)
 *   parses out the ID and hands the right URI scheme to the OS.
 *
 * Scope:
 *   Runs on every record whose `links.spotify` still looks like a search
 *   URL. Records that already resolved to a real album URL are skipped —
 *   idempotent and cheap to rerun.
 *
 * Failure modes:
 *   - No SPOTIFY_CLIENT_ID / SECRET → script exits 0 without touching the
 *     file (calling workflow step stays green). This keeps the daily pool
 *     workflow working when the secret isn't set yet.
 *   - Spotify auth / rate-limit / network error → logged, record kept as
 *     search URL, continue to the next one. One broken lookup shouldn't
 *     block the rest.
 *
 * Progressive save on every successful resolution so a crash is cheap.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { hasCreds, searchAlbum } from "./sources/spotify.mjs";

const FILE = path.resolve("data/recommendations.json");

/**
 * True when the stored Spotify link is a generic search URL (seed-time
 * default) rather than a real album URL. /search/… and any host using the
 * `q=` query param both count.
 */
function isSearchUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    if (u.pathname.toLowerCase().includes("/search")) return true;
    if (u.searchParams.has("q")) return true;
  } catch {
    return true;
  }
  return false;
}

/** Strip Discogs's "Artist (N)" disambiguation marker before querying. */
function stripDiscogsSuffix(name) {
  return (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

async function main() {
  if (!hasCreds()) {
    console.log(
      "backfill-spotify: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set — skipping.",
    );
    return;
  }

  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let resolved = 0;
  let missed = 0;
  let skipped = 0;

  for (const item of items) {
    const current = item.links?.spotify;
    if (current && !isSearchUrl(current)) {
      skipped++;
      continue;
    }
    const artist = stripDiscogsSuffix(item.artist);
    const title = item.title;
    process.stdout.write(`${item.artist} - ${item.title}: `);
    try {
      const hit = await searchAlbum(artist, title);
      if (hit) {
        item.links = { ...item.links, spotify: hit.externalUrl };
        resolved++;
        console.log(`spotify:${hit.id}`);
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
      } else {
        missed++;
        console.log("no confident match");
      }
    } catch (e) {
      missed++;
      console.log(`err (${e.message})`);
    }
  }

  console.log(
    `\nSpotify backfill: resolved=${resolved}, missed=${missed}, already_resolved=${skipped}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
