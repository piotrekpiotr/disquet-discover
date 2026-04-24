import type { Links } from "./types";

/**
 * Deep-linking for music-service URLs.
 *
 * Goal: when a visitor clicks a Spotify / Apple Music / Deezer link on a
 * record card, open the release in their installed native app if they have
 * one, and fall back to the website otherwise. Visitors without the app
 * installed should see exactly what they see today (the website opens in a
 * new tab).
 *
 * Browsers deliberately don't expose "is this app installed?" — Apple,
 * Google and Mozilla all regard it as a fingerprinting vector. So we can
 * never *detect* the app; we can only *attempt* a navigation to a custom
 * URI scheme and watch for the tab to go hidden (which strongly implies
 * the OS handed the URL to a native app).
 *
 * This module owns the per-service parsing of a https web URL into the
 * matching native scheme. The React companion (ServiceLink.tsx) owns the
 * click-handling and fallback timing; it's split so the URL logic stays
 * testable and platform-agnostic.
 *
 * Service coverage:
 *
 *   Spotify     open.spotify.com/{type}/{id}   →  spotify:{type}:{id}
 *     Works on all platforms if the Spotify app is installed. The URI
 *     scheme is documented: https://developer.spotify.com/documentation/general/guides/content-linking-guide/
 *
 *   Apple Music music.apple.com/.../album/.../{id}  →  itmss://music.apple.com/...
 *     The `itmss:` scheme is what the Music app registers on macOS and iOS.
 *     `music:` also works on some macOS builds; `itmss:` is the broader
 *     choice. On iOS, Universal Links already route music.apple.com to the
 *     app for most install configurations, but not when the link is clicked
 *     from *within* a browser tab (Safari keeps the user in the browser
 *     unless we force the scheme), which is exactly our case.
 *
 *   Deezer      www.deezer.com/{lang}?/{type}/{id}  →  deezer://www.deezer.com/...
 *     URI scheme works on iOS/Android Deezer apps. Desktop apps exist but
 *     handle web URLs inconsistently, so we only emit the scheme on mobile
 *     and let the https URL open the web player on desktop.
 *
 *   Tidal       tidal.com/browse/{type}/{id}  →  tidal://{type}/{id}
 *     Mobile only; Tidal's desktop app is less ubiquitous so we stay on web
 *     there.
 *
 *   SoundCloud / YouTube / Bandcamp
 *     No URI scheme needed — on mobile, the OS's Universal Links (iOS) and
 *     App Links (Android) intercept the https URL and hand it to the
 *     installed app automatically. On desktop, there's no consumer native
 *     app to target. So clicking the https URL gives the right behavior on
 *     every platform without us doing anything; we return `null` for the
 *     appUrl and the click falls through to the browser's default <a> nav.
 *
 * Non-goals:
 *   - "Launch the Spotify desktop app on Windows" — technically supported
 *     by the scheme, but Windows's protocol handler UX is noisy enough that
 *     we prefer the web player for consistency.
 *   - Auto-detecting the user's region for Apple Music URLs. The input URL
 *     already carries a region segment (/us/, /gb/, ...); the itmss scheme
 *     preserves it.
 */

export type Platform = "ios" | "android" | "macos" | "windows" | "linux" | "other";

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  // iPadOS 13+ reports as Mac in UA but has touch points — sniff both.
  const isIPad =
    /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  if (/iPhone|iPod/.test(ua) || isIPad || /iPad/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

export function isMobile(platform: Platform): boolean {
  return platform === "ios" || platform === "android";
}

/**
 * Turn a https music-service URL into the matching native-scheme URL for
 * the given platform, or return null if we don't have a reliable scheme
 * for this (service, platform) pair. A null return means "just open the
 * web URL as normal" — it is NOT an error.
 */
export function buildAppUrl(
  service: keyof Links,
  webUrl: string,
  platform: Platform,
): string | null {
  if (!webUrl) return null;
  let u: URL;
  try {
    u = new URL(webUrl);
  } catch {
    return null;
  }

  switch (service) {
    case "spotify":
      return spotifyAppUrl(u);
    case "apple":
      return appleAppUrl(u);
    case "deezer":
      return isMobile(platform) ? deezerAppUrl(u) : null;
    case "tidal":
      return isMobile(platform) ? tidalAppUrl(u) : null;
    // SoundCloud / YouTube / Bandcamp: rely on mobile Universal/App Links
    // for the https URL on mobile, and there's no meaningful desktop native
    // target. Return null and let the browser handle the <a> normally.
    case "soundcloud":
    case "youtube":
    case "bandcamp":
      return null;
    default:
      return null;
  }
}

function spotifyAppUrl(u: URL): string | null {
  if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
  // Match /album/ID, /track/ID, /playlist/ID, /artist/ID, /show/ID, /episode/ID.
  // Tolerate an optional /intl-xx/ region segment (open.spotify.com ships
  // these for localised share URLs).
  const m = u.pathname.match(
    /(?:^|\/)(?:intl-[a-z-]+\/)?(album|track|playlist|artist|show|episode)\/([A-Za-z0-9]+)/i,
  );
  if (!m) return null;
  return `spotify:${m[1].toLowerCase()}:${m[2]}`;
}

function appleAppUrl(u: URL): string | null {
  if (!u.hostname.endsWith("music.apple.com")) return null;
  // Swap the scheme; keep host, path, query. itmss:// is what both the
  // macOS Music app and the iOS Music app register as their URL handler.
  return `itmss://${u.hostname}${u.pathname}${u.search}${u.hash}`;
}

function deezerAppUrl(u: URL): string | null {
  if (!/(^|\.)deezer\.com$/.test(u.hostname)) return null;
  return `deezer://${u.hostname}${u.pathname}${u.search}`;
}

function tidalAppUrl(u: URL): string | null {
  if (!/(^|\.)tidal\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(
    /(?:^|\/)(?:browse\/)?(album|track|playlist|artist|video|mix)\/([A-Za-z0-9-]+)/i,
  );
  if (!m) return null;
  return `tidal://${m[1].toLowerCase()}/${m[2]}`;
}
