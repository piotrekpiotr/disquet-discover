#!/usr/bin/env node
/**
 * Upgrade `links.spotify` and `links.tidal` to real album URLs using
 * the Songlink / Odesli public API as the resolver — no Spotify or
 * Tidal auth required, one call covers both platforms.
 *
 * Why Songlink:
 *   The old Spotify-only version of this script used the Spotify Web
 *   API (Client Credentials flow), but that's now gated behind paid
 *   Premium / Developer-Quota tier the curator doesn't have.
 *   Tidal's Web API is similarly OAuth-gated and unsuitable for
 *   sync-time resolution. Songlink (api.song.link) sidesteps both:
 *   feed it any platform URL — Apple Music, Deezer, iTunes — and it
 *   returns the equivalent URL on every other major platform. No
 *   auth, no signups, generous public rate limits.
 *
 *     GET https://api.song.link/v1-alpha.1/links?url=<encoded url>
 *       → { linksByPlatform: {
 *             spotify: { url, nativeAppUriMobile, ... },
 *             tidal:   { url: "https://listen.tidal.com/album/<id>", ... },
 *             ... }
 *         }
 *
 *   The trick: Songlink needs a SOURCE URL. We already have one for
 *   almost every record — `links.apple` is populated by enrich-
 *   labels-and-embeds and backfill-embeds whenever iTunes resolved
 *   the record, and `links.deezer` is populated when Deezer resolved
 *   it. Either is a great Songlink seed.
 *
 * Coverage observed (2026-04-30 sample, 4 niche-electronic records):
 *   - mu tate / life of mu: spotify NO, tidal YES
 *   - Rival Consoles single: spotify NO, tidal YES
 *   - Martyn / Heavy Sound: spotify NO, tidal NO
 *   - Olof Dreijer / Loud Bloom: spotify NO, tidal NO
 *
 *   Tidal coverage is materially better than Spotify for our
 *   leftfield-electronic catalog. Spotify hits ~0% via Songlink
 *   (Spotify's catalog gap on niche electronic is its own problem);
 *   Tidal hits ~30-50% in spot-checks. Worth running for Tidal alone.
 *
 * Pipeline per record:
 *   1. Skip if BOTH spotify and tidal are already real album URLs.
 *   2. If `links.apple` is a real album URL, query Songlink once.
 *   3. Else if `links.deezer` is real, query Songlink once.
 *   4. Else nothing to resolve — leave whatever's there alone.
 *   5. From the response, write spotify and tidal independently:
 *      each may be present or missing per record.
 *
 * Failure modes:
 *   - Songlink 404 / unknown URL → leave both links alone, log miss.
 *   - 5xx / network error → backoff + one retry, then give up.
 *
 * Progressive save on every resolution so a crash is cheap to resume.
 * Idempotent: a real album URL on either platform skips the lookup
 * if the OTHER platform is also already real.
 *
 * (Filename kept as backfill-spotify.mjs to preserve the existing
 * GitHub Actions step name; the script now does both platforms
 * because they ride a single Songlink call.)
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
 * Ask Songlink for the full linksByPlatform object. Returns null on
 * miss / network error. One automatic retry on 5xx before giving up.
 */
async function resolveViaSonglink(seedUrl) {
  const endpoint = `https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(seedUrl)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(endpoint, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null; // unknown URL — Songlink doesn't track it
      if (!res.ok) {
        if (attempt === 1) {
          await polite(1500);
          continue;
        }
        return null;
      }
      const j = await res.json();
      return j?.linksByPlatform || null;
    } catch {
      if (attempt === 1) {
        await polite(1500);
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Pick a usable Spotify URL from Songlink's response. Defensive
 * because some endpoints return alternate Spotify hosts (play.spotify
 * .com, etc.) that aren't usable for our deep-link logic.
 */
function pickSpotify(platforms) {
  const u = platforms?.spotify?.url;
  return typeof u === "string" && u.includes("open.spotify.com") ? u : null;
}

/**
 * Pick a Tidal URL. Songlink returns "https://listen.tidal.com/
 * album/<id>" — that's the canonical playable link, which Tidal's
 * iOS/Android Universal Links route to the native app. We accept
 * either listen.tidal.com or tidal.com (both surface the same
 * content; mobile apps handle both). buildAppUrl in music-links.ts
 * already knows how to take "tidal.com/browse/album/<id>" and emit
 * the URI scheme; keep the canonical /album/<id> shape.
 */
function pickTidal(platforms) {
  const u = platforms?.tidal?.url;
  if (typeof u !== "string") return null;
  // Songlink's tidal URLs sometimes look like
  // "https://listen.tidal.com/album/507403117" — convert to the
  // tidal.com canonical form so our music-links.ts URI-scheme
  // builder (which expects tidal.com/browse/album/<id> or similar)
  // picks it up cleanly. Both hosts work in browsers; the canonical
  // form is what Tidal's deep-link guidance recommends.
  if (u.includes("listen.tidal.com")) {
    return u.replace("listen.tidal.com", "tidal.com");
  }
  if (u.includes("tidal.com")) return u;
  return null;
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let spotifyResolved = 0;
  let tidalResolved = 0;
  let noSeed = 0;
  let noMatch = 0;
  let skipped = 0;

  for (const item of items) {
    const haveSpotify = isRealUrl(item.links?.spotify);
    const haveTidal = isRealUrl(item.links?.tidal);
    if (haveSpotify && haveTidal) {
      skipped++;
      continue;
    }

    const seed = isRealUrl(item.links?.apple)
      ? item.links.apple
      : isRealUrl(item.links?.deezer)
        ? item.links.deezer
        : null;

    if (!seed) {
      noSeed++;
      continue;
    }

    process.stdout.write(`${item.artist} - ${item.title}: `);
    const platforms = await resolveViaSonglink(seed);
    const updates = {};
    if (!haveSpotify) {
      const sp = pickSpotify(platforms);
      if (sp) {
        updates.spotify = sp;
        spotifyResolved++;
      }
    }
    if (!haveTidal) {
      const td = pickTidal(platforms);
      if (td) {
        updates.tidal = td;
        tidalResolved++;
      }
    }

    if (Object.keys(updates).length > 0) {
      item.links = { ...item.links, ...updates };
      const summary = Object.keys(updates)
        .map((k) => `${k} ✓`)
        .join(" ");
      console.log(summary);
      await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
    } else {
      noMatch++;
      console.log("no songlink match");
    }
    await polite(PER_REQUEST_DELAY_MS);
  }

  console.log(
    `\nSonglink backfill: spotify=+${spotifyResolved}, tidal=+${tidalResolved}, ` +
      `no_seed=${noSeed}, no_match=${noMatch}, fully_resolved=${skipped}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
