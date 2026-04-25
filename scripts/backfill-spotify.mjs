#!/usr/bin/env node
/**
 * Upgrade `links.spotify` from "open.spotify.com/search/…" to a real
 * Spotify album URL, using the Songlink / Odesli public API as the
 * resolver — no Spotify auth required.
 *
 * Backstory: the old version of this script used the Spotify Web API
 * (Client Credentials flow). That flow has since been gated behind a
 * paid Spotify Premium / Developer-Quota tier on the curator's
 * account, so we can't use it any more. Spotify's other SDKs aren't a
 * fit either:
 *   - Web Playback SDK / iOS SDK / Android SDK are PLAYBACK SDKs, not
 *     metadata APIs — they need a logged-in user and exist to render
 *     audio inside an app. We don't render audio; we just need an
 *     album ID for a known artist+title.
 *   - Spotify "App Remote" / iOS / Android only run on a device that
 *     has Spotify installed; meaningless in a Node.js sync script.
 *
 * Songlink (api.song.link, by the people behind Odesli) is purpose-
 * built for this: feed it any platform URL — Apple Music, Deezer,
 * iTunes — and it returns the equivalent URL on every other major
 * platform, including Spotify. No auth, no signups, generous public
 * rate limits.
 *
 *   GET https://api.song.link/v1-alpha.1/links?url=<encoded url>
 *     → { linksByPlatform: { spotify: { url, nativeAppUriMobile, ... } } }
 *
 * The trick: Songlink needs a SOURCE URL. We already have one for
 * almost every record — `links.apple` is populated by enrich-labels-
 * and-embeds and backfill-embeds whenever iTunes resolved the record,
 * and `links.deezer` is populated when Deezer resolved it. Both are
 * great Songlink seeds.
 *
 * Pipeline per record (skipped when `links.spotify` is already a real
 * album URL):
 *   1. If `links.apple` is a real album URL, query Songlink with it.
 *   2. Else if `links.deezer` is a real album URL, query Songlink.
 *   3. Else nothing to resolve — leave the search URL alone (the
 *      site's runtime fallback opens Spotify search, which still works).
 *
 * Failure modes:
 *   - Songlink returns 404 / no Spotify entry → keep the search URL,
 *     log "no spotify match", carry on.
 *   - Network error / 5xx → polite backoff, retry once, then keep
 *     the search URL.
 *
 * Progressive save on every resolution so a crash is cheap to resume.
 *
 * Idempotent: only processes records whose `links.spotify` is still a
 * search URL.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +songlink";

// Songlink throttles politely at "a few per second" with no published
// hard limit. 350ms keeps us comfortably under any reasonable bar and
// still finishes a few-thousand-record file in well under an hour.
const PER_REQUEST_DELAY_MS = 350;

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

function isRealUrl(url) {
  return Boolean(url) && !isSearchUrl(url);
}

async function polite(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Ask Songlink for the Spotify equivalent of a known platform URL.
 * Returns the album URL on success, null on miss. One automatic retry
 * on 5xx / network error before giving up.
 */
async function resolveViaSonglink(seedUrl) {
  const endpoint = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(seedUrl)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(endpoint, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null; // unknown URL — Songlink doesn't track it
      if (!res.ok) {
        // 429 / 5xx — back off and retry once.
        if (attempt === 1) {
          await polite(1500);
          continue;
        }
        return null;
      }
      const j = await res.json();
      const spotify = j?.linksByPlatform?.spotify?.url;
      if (typeof spotify === "string" && spotify.includes("open.spotify.com")) {
        return spotify;
      }
      return null;
    } catch (e) {
      if (attempt === 1) {
        await polite(1500);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let resolved = 0;
  let noSeed = 0;
  let noMatch = 0;
  let skipped = 0;

  for (const item of items) {
    const current = item.links?.spotify;
    if (current && !isSearchUrl(current)) {
      skipped++;
      continue;
    }

    // Pick the best source URL to feed Songlink with.
    const seed = isRealUrl(item.links?.apple)
      ? item.links.apple
      : isRealUrl(item.links?.deezer)
        ? item.links.deezer
        : null;

    if (!seed) {
      // Nothing for Songlink to anchor on. Search URL is the best we can do.
      noSeed++;
      continue;
    }

    process.stdout.write(`${item.artist} - ${item.title}: `);
    const url = await resolveViaSonglink(seed);
    if (url) {
      item.links = { ...item.links, spotify: url };
      resolved++;
      console.log(`spotify ✓ (${url.split("/").pop()?.split("?")[0] || "ok"})`);
      await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
    } else {
      noMatch++;
      console.log("no spotify on songlink");
    }
    await polite(PER_REQUEST_DELAY_MS);
  }

  console.log(
    `\nSpotify backfill (Songlink): resolved=${resolved}, no_seed=${noSeed}, no_match=${noMatch}, already_resolved=${skipped}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
