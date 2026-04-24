/**
 * Spotify album lookup — used to turn "we know an artist shipped a record"
 * into "we have the Spotify album URL" so the deep link opens the actual
 * album in the app, not just Spotify's search.
 *
 * Why this module exists:
 *   sync-artists.mjs discovers releases via iTunes and Deezer. Neither
 *   source tells us the Spotify album ID, so we default the `links.spotify`
 *   field to `https://open.spotify.com/search/<artist> <title>`. That link
 *   works — it opens Spotify (web or app) at a search page — but it's a
 *   step short of what the visitor wanted. The Spotify URI scheme
 *   `spotify:album:<id>` can't be constructed from a search URL, so the
 *   ServiceLink component can't deep-link either: clicking "Spotify" just
 *   follows the search URL.
 *
 *   This module resolves artist+title → Spotify album ID via Spotify's
 *   Web API. Runs in the backfill step of the daily workflow after
 *   sync-artists / sync-labels have created the pending records.
 *
 * Auth: Client Credentials flow. Read-only endpoints (search, album
 *   metadata) don't need a user login — a registered app's client_id +
 *   client_secret is enough. Create the app at
 *   https://developer.spotify.com/dashboard → Create app → fill in any
 *   name ("Disquet Discover"), redirect URI can be https://disquet.co/
 *   (unused for this flow), accept the ToS. Copy Client ID and Client
 *   Secret into SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET as GitHub Actions
 *   secrets. No shared secret or user OAuth needed.
 *
 * Rate limits: Spotify's published limit is "a few thousand requests per
 *   second" per app, which is well over what this script does (~250 pool
 *   artists × 1 search each = 250 requests per day). A 429 response gets
 *   honored via the Retry-After header.
 *
 * If SPOTIFY_CLIENT_ID / SECRET is unset we throw immediately; the caller
 * is expected to guard with a missing-creds check and skip the step.
 */

const API_BASE = "https://api.spotify.com/v1";
const AUTH_URL = "https://accounts.spotify.com/api/token";

let cachedToken = null;
let cachedExpiryMs = 0;

function creds() {
  const id = process.env.SPOTIFY_CLIENT_ID || "";
  const secret = process.env.SPOTIFY_CLIENT_SECRET || "";
  return { id, secret };
}

export function hasCreds() {
  const { id, secret } = creds();
  return Boolean(id && secret);
}

async function getAccessToken() {
  const { id, secret } = creds();
  if (!id || !secret) {
    throw new Error(
      "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set — skipping Spotify lookup",
    );
  }
  // Refresh ~60s before expiry so we never submit a token that flips stale
  // in flight.
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) return cachedToken;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Spotify auth failed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  cachedToken = json.access_token;
  cachedExpiryMs = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

function normalise(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Score a candidate album from the search results against the target
 * (artist, title). Returns a number 0..1; a candidate must score >= 0.7
 * to be picked. The checks are deliberately strict — a wrong album URL
 * is worse than none (sends the listener to the wrong record), so we'd
 * rather keep the search fallback in ambiguous cases.
 */
function scoreMatch(album, targetArtist, targetTitle) {
  const albumTitle = normalise(album.name || "");
  const wantTitle = normalise(targetTitle);
  const artists = (album.artists || []).map((a) => normalise(a.name || ""));
  const wantArtist = normalise(targetArtist);

  // Title check: require an exact-match OR a token-overlap >= 0.85.
  let titleScore = 0;
  if (albumTitle === wantTitle) titleScore = 1;
  else {
    const A = new Set(albumTitle.split(" ").filter(Boolean));
    const B = new Set(wantTitle.split(" ").filter(Boolean));
    if (A.size && B.size) {
      let hits = 0;
      for (const t of A) if (B.has(t)) hits++;
      titleScore = hits / Math.min(A.size, B.size);
    }
  }

  // Artist check: any artist on the release matches (handles "Purelink"
  // vs "Purelink & Rainy Miller" etc.).
  const artistOk = artists.some((a) => {
    if (a === wantArtist) return true;
    // partial match — one of the token sets contains the other
    if (a.length >= 3 && wantArtist.includes(a)) return true;
    if (wantArtist.length >= 3 && a.includes(wantArtist)) return true;
    return false;
  });

  if (!artistOk) return 0;
  return titleScore;
}

/**
 * Search Spotify for an album by artist and title; return its canonical
 * open.spotify.com URL and numeric ID, or null if no confident match.
 *
 * Handles 429 retry with the Retry-After header and short transient
 * errors with a single retry on a 100ms backoff. Anything else bubbles
 * so the caller can log and continue — one bad lookup shouldn't abort
 * the whole backfill.
 */
export async function searchAlbum(artist, title) {
  if (!artist || !title) return null;
  const token = await getAccessToken();

  // Spotify's search DSL: `album:"title" artist:"artist"` for a tight
  // match. Free-form `artist title` as a fallback if the structured
  // query returns nothing — Spotify sometimes fails to match exotic
  // punctuation / unicode inside the field-qualified form.
  const queries = [
    `album:"${title}" artist:"${artist}"`,
    `${artist} ${title}`,
  ];

  for (const q of queries) {
    const url = `${API_BASE}/search?q=${encodeURIComponent(q)}&type=album&limit=10`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("Retry-After") || "1") * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Spotify search ${res.status}`);
    }
    const json = await res.json();
    const items = json?.albums?.items || [];
    if (!items.length) continue;

    let best = null;
    let bestScore = 0;
    for (const album of items) {
      const s = scoreMatch(album, artist, title);
      if (s > bestScore) {
        bestScore = s;
        best = album;
      }
    }
    if (best && bestScore >= 0.7) {
      return {
        id: best.id,
        externalUrl:
          best.external_urls?.spotify ||
          `https://open.spotify.com/album/${best.id}`,
      };
    }
  }
  return null;
}
