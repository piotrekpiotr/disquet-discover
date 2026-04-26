"use client";
import { useEffect, useState } from "react";
import type { Embed, Links } from "@/lib/types";
import {
  getConsent,
  onConsentChange,
  setConsent,
  type ConsentState,
} from "@/lib/consent";
import { ServiceLink } from "./ServiceLink";

/**
 * Embed priority, when we start storing multiple providers per record:
 *   bandcamp  - highest priority (cleanest UX, clear track list, free)
 *   apple     - second (works without auth, ~450px player with pause visible)
 *   spotify   - third (requires login for full playback, 30s previews otherwise)
 *   deezer    - fourth (free 30s previews, wide catalog of leftfield releases
 *               that iTunes doesn't always have; good fallback for the tail)
 *   soundcloud / youtube - last resort (the embed field on a record is a single
 *     object today; the helper still picks the best provider so when multiple
 *     are stored on a record, the correct one renders without further work).
 *
 * Today the `embed` field is a single object, so `pickEmbed` just passes it
 * through. The function exists so future multi-provider support (`embeds: Embed[]`)
 * can be added without touching the card.
 */
const PROVIDER_PRIORITY: Embed["provider"][] = [
  "bandcamp",
  "apple",
  "spotify",
  "deezer",
  "soundcloud",
  "youtube",
];

function pickEmbed(embed: Embed | null | undefined): Embed | null {
  if (!embed) return null;
  // Single-provider case today. If the type evolves to Embed[] this sorts by priority.
  if (Array.isArray(embed)) {
    const list = embed as Embed[];
    for (const p of PROVIDER_PRIORITY) {
      const hit = list.find((e) => e.provider === p);
      if (hit) return hit;
    }
    return list[0] ?? null;
  }
  return embed;
}

/**
 * Apple-Music album URL → embed URL. Apple's official embed iframe just
 * rewrites the host (`music.apple.com` → `embed.music.apple.com`) and
 * tacks `?theme=light`. Used when we have a confident album link but no
 * stored embed (or an embed we want to override).
 *
 * Returns null if the URL doesn't look like a real Apple Music album
 * page — search pages, artist pages, and anything off-host stay as-is.
 */
function appleEmbedFromAlbumUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("music.apple.com")) return null;
    if (!/\/album\//i.test(u.pathname)) return null;
    return `https://embed.music.apple.com${u.pathname}?theme=light`;
  } catch {
    return null;
  }
}

/**
 * Last-line provider preference at render time. Deezer is the curator's
 * least-loved player ("only as a very last resort"), so when a record has
 * BOTH a Deezer-stored embed AND a confident Apple album URL in
 * links.apple, swap the embed to Apple on the fly. This gives an instant
 * upgrade for the long tail of records where backfill-embeds.mjs landed
 * on Deezer because iTunes throttled at the time, even before the
 * matching upgrade-deezer-to-apple.mjs pass has run on disk.
 *
 * The transformation is purely cosmetic — it doesn't mutate the stored
 * record. The next time backfill or the upgrade script runs, the disk
 * record gets the same swap applied permanently.
 */
function preferAppleOverDeezer(
  embed: Embed | null,
  links: Links,
): Embed | null {
  if (!embed || embed.provider !== "deezer") return embed;
  const appleSrc = appleEmbedFromAlbumUrl(links.apple);
  if (!appleSrc) return embed;
  return { provider: "apple", src: appleSrc, height: 450 };
}

/**
 * Pick a sensible max-width for the embed container so the border around
 * the iframe doesn't stretch to the full 10-column player row on desktop.
 * The player row is wider than any music-service embed is designed for,
 * so without a cap the border looks orphaned around an off-centre player.
 *
 *   1. Curator-set width on the embed (from EmbedPicker / iframe paste)
 *      always wins. Pasting a 350px Bandcamp Big-artwork blob keeps it
 *      at 350px — that's the whole point of persisting width.
 *   2. Bandcamp Big-artwork (artwork=big in the src) is hard-locked at
 *      350px when no width was stored. Bandcamp's layout is built for a
 *      fixed column and stretching it grows the cover absurdly.
 *   3. Everything else falls back to provider-typical maximums that match
 *      the embed's natural rendered size — Apple Music caps around 660,
 *      Spotify the same, Bandcamp slim/responsive ~700, YouTube 720.
 *      The container uses `width: 100%; maxWidth: <cap>` so the border
 *      tracks the player and the player itself remains responsive on
 *      narrower screens.
 */
const PROVIDER_MAX_WIDTH: Record<Embed["provider"], number> = {
  bandcamp: 700,
  apple: 660,
  spotify: 660,
  deezer: 700,
  soundcloud: 700,
  youtube: 720,
};

function inferWidth(embed: Embed): number {
  if (embed.width) return embed.width;
  if (embed.provider === "bandcamp" && /\/artwork=big\b/.test(embed.src)) {
    return 350;
  }
  return PROVIDER_MAX_WIDTH[embed.provider] ?? 700;
}

// Curator-set order under each release card. Bandcamp leads (cleanest
// listening UX, no walls), Apple second (universal app, clean web
// player), Spotify third (largest install base, deep-links via
// spotify:search:<q> when no album URL is resolved). YouTube and
// SoundCloud round out the visible row. Tidal and Deezer trail at
// the end — Deezer specifically is the curator's least-loved player
// ("only as a very last resort"), so it sits last.
const SERVICE_ORDER: Array<keyof Links> = [
  "bandcamp",
  "apple",
  "spotify",
  "youtube",
  "soundcloud",
  "tidal",
  "deezer",
];

const SERVICE_LABELS: Record<keyof Links, string> = {
  bandcamp: "Bandcamp",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  apple: "Apple Music",
  tidal: "Tidal",
  youtube: "YouTube",
  deezer: "Deezer",
};

/**
 * Heuristic: is this a REAL release URL (direct deep link) or just a generic
 * search-results URL left over from seed time? The fallback card below uses
 * this to avoid highlighting a link that actually dumps the admin onto a
 * search page with nothing pre-selected.
 */
function isSearchUrl(url: string): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    const p = u.pathname.toLowerCase();
    if (p.includes("/search") || p === "/results") return true;
    if (u.searchParams.has("q") || u.searchParams.has("search_query")) return true;
  } catch {
    return true;
  }
  return false;
}

export function EmbedPlayer({
  embed,
  musicVideoUrl,
  links,
  searchQuery,
}: {
  embed?: Embed | null;
  musicVideoUrl?: string | null;
  links: Links;
  /** Optional "artist + title" string used to build fresh search fallbacks when
   *  this record has neither an inline embed nor a direct-link to any service. */
  searchQuery?: string;
}) {
  const [showEmbed, setShowEmbed] = useState(false);
  const chosen = preferAppleOverDeezer(pickEmbed(embed), links);

  // Consent gate: third-party iframes (Bandcamp, Spotify, YouTube, ...) set
  // their own cookies the moment they load. Under ePrivacy Art. 5(3) that
  // needs prior user consent, so the <iframe> doesn't render until the
  // visitor has either accepted the site-wide banner or clicked the per-
  // card "load player" button.
  const [consent, setConsentState] = useState<ConsentState>("unset");
  const [cardOverride, setCardOverride] = useState(false);
  useEffect(() => {
    setConsentState(getConsent());
    return onConsentChange(setConsentState);
  }, []);
  const mayLoadEmbed = consent === "accepted" || cardOverride;

  const activeServices = SERVICE_ORDER.filter((k) => links[k]);
  // Direct deep-link services (not generic search URLs) are the "good" links.
  const deepLinkServices = activeServices.filter((k) => !isSearchUrl(links[k]!));

  /**
   * Fallback search URLs, built from the artist+title query. Used when no
   * embed was found AND the record only has the seed-time search URLs. Gives
   * the admin a one-click jump to each service's search results instead of
   * a dead-end "no player" state.
   */
  const q = encodeURIComponent(searchQuery || "");
  const searchFallbacks: Array<{ key: keyof Links; href: string }> = searchQuery
    ? [
        { key: "spotify", href: `https://open.spotify.com/search/${q}` },
        { key: "bandcamp", href: `https://bandcamp.com/search?q=${q}&item_type=a` },
        { key: "apple", href: `https://music.apple.com/us/search?term=${q}` },
        { key: "deezer", href: `https://www.deezer.com/search/${q}` },
        { key: "youtube", href: `https://www.youtube.com/results?search_query=${q}` },
        { key: "soundcloud", href: `https://soundcloud.com/search?q=${q}` },
      ]
    : [];

  return (
    <div className="flex flex-col gap-3">
      {chosen && mayLoadEmbed ? (
        // Width behaviour: we respect the pasted embed's sizing exactly.
        //
        //   - When the embed carries a fixed width (Bandcamp Big-artwork
        //     Standard player, any iframe the curator pasted with an
        //     explicit pixel width), we cap the container to that width.
        //     Forcing such players to 100% width stretches Bandcamp's
        //     cover artwork to absurd sizes because the layout is built
        //     for a fixed column.
        //   - When no width is available (Apple, Deezer, Spotify's
        //     responsive embed, Bandcamp with `width: 100%` in the paste),
        //     we render fluid so the player fills the card.
        //   - `inferWidth` only kicks in as a safety net for historical
        //     Bandcamp big-artwork records saved before width was
        //     persisted; it never overrides a pasted width.
        //
        // Alignment: narrow fixed-width players are LEFT-aligned, not
        // centred. Centring a 250px player inside the 10-col player row
        // lands it in the middle of the card, visually detached from the
        // cover art on the row above (see the curator's Martyn feedback).
        // Left-aligning keeps the player's left edge under the cover's
        // left edge so the record reads as a single compound block.
        <div
          className="border border-ink"
          style={{ width: "100%", maxWidth: `${inferWidth(chosen)}px` }}
        >
          {chosen.provider === "youtube" ? (
            // YouTube videos must keep a 16:9 aspect ratio at every
            // container width — the curator pastes the standard
            // 560×315 embed but the player row narrows on smaller
            // viewports, and a fixed-px height would letterbox or
            // over-tall the video. `aspectRatio: "16 / 9"` is a one-
            // line responsive ratio: width is 100% of the (capped)
            // container, height is computed by the browser to keep
            // the ratio. Also extends the iframe `allow` list to the
            // attributes YouTube's own embed snippet ships, and
            // explicitly opts into fullscreen — without it the YT
            // player's fullscreen button is greyed out.
            <iframe
              src={chosen.src}
              style={{
                width: "100%",
                aspectRatio: "16 / 9",
                border: 0,
                display: "block",
              }}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              title="Player"
            />
          ) : (
            <iframe
              src={chosen.src}
              style={{
                width: "100%",
                height: `${chosen.height ?? 450}px`,
                border: 0,
                display: "block",
              }}
              allow="autoplay; clipboard-write; encrypted-media; picture-in-picture"
              loading="lazy"
              title="Player"
            />
          )}
        </div>
      ) : chosen ? (
        // Click-to-load facade. No iframe in the DOM until the user opts in,
        // so the third-party host sees no request until there's consent.
        <ConsentGate
          providerLabel={chosen.provider}
          onAllow={() => {
            setCardOverride(true);
            // Per-card click also flips site-wide consent to "accepted" so
            // the rest of the page lights up in one go. EDPB calls this
            // "granular" consent; a single "Yes, load players" action
            // across the whole site is allowed when the only embedded
            // category is media players of the same nature.
            setConsent("accepted");
          }}
        />
      ) : musicVideoUrl && showEmbed && mayLoadEmbed ? (
        <div className="aspect-video border border-ink">
          <iframe
            src={musicVideoUrl}
            className="w-full h-full border-0"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            title="Music video"
          />
        </div>
      ) : (
        /*
         * No inline player available. Fall back to a compact card: one primary
         * CTA (preferring a real deep-link, else a search) plus a row of other
         * search entry points. Admin always has somewhere to click through to
         * audition the record, even if auto-embed backfill came up empty.
         */
        <FallbackCard
          musicVideoUrl={musicVideoUrl}
          onPlayVideo={() => setShowEmbed(true)}
          deepLinks={deepLinkServices}
          searchFallbacks={searchFallbacks}
          links={links}
        />
      )}

      {/* When there's an inline player, the services row underneath gives the
          admin "go deeper" links. When there's no player, the FallbackCard
          above is already carrying the CTAs, so we skip this row to avoid
          rendering the same links twice. */}
      {((chosen && mayLoadEmbed) || (musicVideoUrl && showEmbed && mayLoadEmbed)) && activeServices.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-widest">
          {activeServices.map((k) => (
            <ServiceLink
              key={k}
              service={k}
              webUrl={links[k]!}
              className="border-b border-ink hover:text-signal hover:border-signal"
            >
              {SERVICE_LABELS[k]} ↗
            </ServiceLink>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Player-less fallback: renders when no embed iframe is available. Promotes
 * real deep links first, then generic search CTAs, so the admin can always
 * audition the record somewhere. Visually distinct from a real player so it's
 * clear at a glance that inline playback wasn't wired up for this release.
 */
function FallbackCard({
  musicVideoUrl,
  onPlayVideo,
  deepLinks,
  searchFallbacks,
  links,
}: {
  musicVideoUrl?: string | null;
  onPlayVideo: () => void;
  deepLinks: Array<keyof Links>;
  searchFallbacks: Array<{ key: keyof Links; href: string }>;
  links: Links;
}) {
  // If the record has any real deep-link services, surface up to 3 of them as
  // the primary row. Otherwise the entire row is search-fallbacks.
  const primary =
    deepLinks.length > 0
      ? deepLinks
          .slice(0, 4)
          .map((k) => ({ key: k, href: links[k]!, isSearch: false }))
      : searchFallbacks
          .slice(0, 4)
          .map(({ key, href }) => ({ key, href, isSearch: true }));

  return (
    <div className="border border-ink bg-paper-2/40 px-5 py-6 flex flex-col gap-4">
      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest text-mute">
        <span className="inline-block w-1.5 h-1.5 bg-mute rounded-full" />
        No inline player for this release
      </div>
      <p className="font-body text-[14px] leading-snug text-ink/80 max-w-[52ch]">
        Inline playback couldn&apos;t be wired up automatically. Audition the
        release on one of these services instead
        {primary.length > 0 && primary[0].isSearch ? " (opens a search)" : ""}:
      </p>
      <div className="flex flex-wrap gap-2">
        {primary.map(({ key, href, isSearch }) =>
          // Direct release links get the deep-link treatment; search URLs
          // stay as plain anchors (there's no native app screen for
          // "spotify search results for 'Artist Title'", and deep-linking
          // to such a URI would just open the user's library).
          isSearch ? (
            <a
              key={`${key}-s`}
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper transition-colors"
            >
              Search {SERVICE_LABELS[key]} ↗
            </a>
          ) : (
            <ServiceLink
              key={`${key}-d`}
              service={key}
              webUrl={href}
              className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper transition-colors"
            >
              Open {SERVICE_LABELS[key]} ↗
            </ServiceLink>
          ),
        )}
        {musicVideoUrl && (
          <button
            onClick={onPlayVideo}
            className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper transition-colors"
          >
            Play video ▸
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Click-to-load facade. Renders a small placeholder describing which
 * provider is behind the card + what clicking will do; only when the
 * visitor clicks does the real iframe get inserted. This is the
 * GDPR / ePrivacy-compliant way to show third-party embedded media
 * without setting cookies up-front.
 */
function ConsentGate({
  providerLabel,
  onAllow,
}: {
  providerLabel: string;
  onAllow: () => void;
}) {
  const nice =
    providerLabel.charAt(0).toUpperCase() + providerLabel.slice(1);
  return (
    <div className="border border-ink bg-paper-2/40 px-5 py-6 flex flex-col gap-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-mute">
        Player blocked until you allow embeds
      </div>
      <p className="font-body text-[14px] leading-snug text-ink/85 max-w-[52ch]">
        The inline player for this release comes from {nice}. Loading it
        sets {nice}&apos;s cookies. Click below to load it - your choice
        is remembered for the whole site.
      </p>
      <div>
        <button
          onClick={onAllow}
          className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper border border-ink px-4 py-2 hover:bg-paper hover:text-ink"
        >
          Load {nice} player
        </button>
      </div>
    </div>
  );
}
