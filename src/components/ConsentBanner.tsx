"use client";
import { useEffect, useState } from "react";
import { getConsent, setConsent, type ConsentState } from "@/lib/consent";

/**
 * Bottom-of-page consent banner. Only shown when the visitor hasn't made
 * a choice yet ("unset"). Three actions:
 *   - Accept: embeds render inline.
 *   - Decline: embeds stay as click-to-load cards; no third-party cookies
 *     are set until the visitor clicks a specific player.
 *   - Close (X): same as Decline, for the "I don't want to deal with this
 *     right now" case - we take silence as refusal, per ePrivacy.
 *
 * The banner intentionally does NOT block the page (no modal, no backdrop)
 * because the site works entirely without embeds: the FallbackCard and
 * streaming-service links give a full audition path without triggering a
 * single tracker.
 */
export function ConsentBanner() {
  const [state, setState] = useState<ConsentState>("unset");
  const [mounted, setMounted] = useState(false);

  // First-paint flash avoidance: render nothing until we've read localStorage
  // on the client, so SSR output doesn't mismatch and the banner doesn't
  // flicker for accepted users.
  useEffect(() => {
    setState(getConsent());
    setMounted(true);
  }, []);

  // Full banner: only when the visitor has not made a choice yet.
  // Slim reminder: when they declined, so there is always a one-click way
  // back to "allow players" without hunting for a settings page.
  if (!mounted || state === "accepted") return null;

  if (state === "declined") {
    return (
      <div
        role="status"
        aria-label="Embedded players blocked"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-ink bg-paper/95 backdrop-blur-sm"
      >
        <div className="px-6 sm:px-8 py-3 flex items-center gap-4 sm:gap-6">
          <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
            Embedded players blocked site-wide
          </p>
          <button
            onClick={() => {
              setConsent("accepted");
              setState("accepted");
            }}
            className="ml-auto font-mono text-[10px] uppercase tracking-widest bg-ink text-paper border border-ink px-3 py-2 hover:bg-paper hover:text-ink"
          >
            Allow players
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Cookies and embedded players"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink bg-paper/95 backdrop-blur-sm"
    >
      <div className="px-6 sm:px-8 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <p className="font-body text-[13px] leading-snug text-ink/85 max-w-[68ch]">
          This site embeds players from Bandcamp, Apple Music, Spotify,
          SoundCloud, YouTube, and Deezer. When they load they set their
          own cookies. The site itself uses no analytics, no tracking, and
          no third-party ads. Allow embedded players?
        </p>
        <div className="flex gap-2 sm:ml-auto flex-shrink-0">
          <button
            onClick={() => {
              setConsent("declined");
              setState("declined");
            }}
            className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-2 hover:bg-ink hover:text-paper"
          >
            Decline
          </button>
          <button
            onClick={() => {
              setConsent("accepted");
              setState("accepted");
            }}
            className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper border border-ink px-3 py-2 hover:bg-paper hover:text-ink"
          >
            Allow players
          </button>
        </div>
      </div>
    </div>
  );
}
