"use client";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Links } from "@/lib/types";
import {
  buildAppUrl,
  detectPlatform,
  isMobile,
  type Platform,
} from "@/lib/music-links";

/**
 * A link to a music service that prefers opening the native app (when the
 * visitor has it installed) and falls back to the web URL otherwise.
 *
 * The hard constraint: browsers do not expose "is app installed", for
 * fingerprinting reasons. So this component's fallback is detected, not
 * predicted — we kick off the app URL, watch for the page to go hidden
 * (OS handed the URL to an app → browser backgrounds), and if nothing
 * happens within a short window we assume no app and open the web URL in
 * a new tab.
 *
 * What's rendered:
 *   A plain <a href={webUrl} target="_blank">. If JS fails or is disabled,
 *   the link still works — it just opens the website, same as today.
 *
 * Click flow when we have an appUrl for this service:
 *   1. preventDefault — we take over the click.
 *   2. window.open("", "_blank") to claim a tab while we still have the
 *      user-gesture context. Popup blockers only allow a new tab as a
 *      direct consequence of the click; any window.open scheduled from a
 *      setTimeout would be blocked. We need this tab in case the fallback
 *      fires.
 *   3. window.location.href = appUrl. Modern browsers hand the URL to the
 *      OS protocol handler; if an app is registered, it opens and our tab
 *      goes hidden. If no handler is registered, most browsers quietly
 *      do nothing (Safari iOS, Chrome) or show a tiny unobtrusive error
 *      (Safari macOS), and our page stays in view.
 *   4. 1500ms timer. When it fires, if our page is STILL visible, assume
 *      the app didn't open and navigate the pre-opened fallback tab to
 *      the web URL. If the page went hidden (app opened), cancel the
 *      timer and close the still-blank fallback tab.
 *
 * When there's no appUrl for this (service, platform) — SoundCloud on
 * desktop, YouTube, Bandcamp, anything we don't know how to deep-link —
 * we don't hijack the click at all; the browser opens webUrl in a new tab
 * as it would for any external link. On mobile, Universal Links / App
 * Links will still route the https URL to the installed native app
 * automatically; that behavior is provided by the OS, not by us.
 */
const FALLBACK_MS = 1500;

export function ServiceLink({
  service,
  webUrl,
  className,
  children,
}: {
  service: keyof Links;
  webUrl: string;
  className?: string;
  children: ReactNode;
}) {
  // Platform detection happens once on mount. Done in state (not computed
  // inline) so the server-rendered markup matches the first client render:
  // on the server we render with platform="other" (appUrl = null for most
  // services in most cases, which is fine — the <a> still has the web URL
  // as its href), and after hydration we recompute with the real platform.
  const [platform, setPlatform] = useState<Platform>("other");
  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  // Track whether a deep-link attempt for this click is in flight. Prevents
  // double-taps from stacking timers/fallbacks on top of each other.
  const inFlightRef = useRef(false);

  const appUrl = buildAppUrl(service, webUrl, platform);

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Let Cmd/Ctrl-click, middle-click, Shift-click through — they all mean
    // "I want to control where this link opens", and hijacking those feels
    // broken even if the end result would be the same tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    if (!appUrl) {
      // No deep link for this (service, platform). Let the browser open
      // webUrl in a new tab via the anchor's target="_blank".
      return;
    }
    if (inFlightRef.current) {
      e.preventDefault();
      return;
    }
    inFlightRef.current = true;
    e.preventDefault();

    // Two completely different strategies, because mobile Safari and
    // desktop Chrome/Safari disagree sharply on what's legal mid-click:
    //
    //   - On DESKTOP, we can call `window.open("", "_blank")` while the
    //     user-gesture context is live, claim that tab, then navigate it
    //     to the fallback web URL later if the app didn't open. This
    //     preserves the original disquet.co tab.
    //
    //   - On MOBILE (iOS Safari especially), `window.open("", "_blank")`
    //     is reliably popup-blocked — it returns `null`, and no amount of
    //     cleverness will un-block it. That's why the Apple Music tap was
    //     "doing nothing" before this fix: we pre-opened a null tab, set
    //     location.href to itmss:// (which iOS silently rejected), the
    //     timer fired, tried to navigate the null fallbackTab, and
    //     `window.open(webUrl, "_blank")` from inside a timeout is also
    //     popup-blocked since the user gesture has expired. End result: a
    //     page that looks like it reloaded and nothing happened.
    //
    //     On mobile we use current-tab navigation for everything. If the
    //     app opens, great — our tab backgrounds. If it doesn't, 1.5s
    //     later we navigate the current tab itself to the web URL. The
    //     visitor loses the disquet.co page and can hit Back to return —
    //     worse UX than desktop, but it actually works.
    if (isMobile(platform)) {
      handleMobile(appUrl, webUrl, () => {
        inFlightRef.current = false;
      });
      return;
    }

    handleDesktop(appUrl, webUrl, () => {
      inFlightRef.current = false;
    });
  }

  return (
    <a
      href={webUrl}
      target="_blank"
      rel="noreferrer noopener"
      onClick={handleClick}
      className={className}
    >
      {children}
    </a>
  );
}

/**
 * Mobile deep-link attempt. Current-tab navigation for both the app URI
 * and the fallback, because window.open popups aren't reliably allowed
 * mid-click on iOS Safari. If the app handles the scheme, the current
 * tab backgrounds (visibilitychange fires) and we stand down. Otherwise
 * we navigate the same tab to the website.
 *
 * A subtle bit: when the OS hand-off happens, some iOS versions fire
 * `pagehide` instead of (or in addition to) visibilitychange. We listen
 * to both so we don't later navigate on top of a successful launch.
 */
function handleMobile(appUrl: string, webUrl: string, done: () => void) {
  let cancelled = false;
  const stopAll = () => {
    cancelled = true;
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", stopAll);
    window.removeEventListener("blur", stopAll);
    done();
  };
  const onVis = () => {
    if (document.visibilityState === "hidden") stopAll();
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", stopAll, { once: true });
  window.addEventListener("blur", stopAll, { once: true });

  window.setTimeout(() => {
    if (cancelled) return;
    // App didn't open. Take the current tab to the web URL instead; the
    // user can tap Back to return to us. On iOS this is also the ONLY
    // remaining window-opening action available (the gesture is gone,
    // popups are blocked).
    window.location.href = webUrl;
    stopAll();
  }, FALLBACK_MS);

  // Kick the native URI scheme in the current tab. If registered, the OS
  // pauses this tab and opens the app.
  try {
    window.location.href = appUrl;
  } catch {
    // Immediate fallback
    window.location.href = webUrl;
    stopAll();
  }
}

/**
 * Desktop deep-link attempt. Pre-open a blank tab while the user gesture
 * is valid, try the app URI in the current tab, and if the timer fires
 * before the page backgrounds, point the pre-opened tab at the website.
 * This keeps the disquet.co tab untouched on desktop — the visitor
 * expects a new tab for an external link there.
 */
function handleDesktop(appUrl: string, webUrl: string, done: () => void) {
  const fallbackTab = window.open("", "_blank");

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    document.removeEventListener("visibilitychange", onVis);
    done();
  };

  const onVis = () => {
    if (document.visibilityState === "hidden") {
      clearTimeout(timer);
      if (fallbackTab && !fallbackTab.closed) {
        try {
          fallbackTab.close();
        } catch {
          /* swallow */
        }
      }
      cleanup();
    }
  };
  document.addEventListener("visibilitychange", onVis);

  const timer = window.setTimeout(() => {
    if (finished) return;
    if (fallbackTab && !fallbackTab.closed) {
      try {
        fallbackTab.location.href = webUrl;
      } catch {
        window.open(webUrl, "_blank", "noopener,noreferrer");
      }
    } else {
      window.open(webUrl, "_blank", "noopener,noreferrer");
    }
    cleanup();
  }, FALLBACK_MS);

  try {
    window.location.href = appUrl;
  } catch {
    clearTimeout(timer);
    if (fallbackTab && !fallbackTab.closed) {
      try {
        fallbackTab.location.href = webUrl;
      } catch {
        window.open(webUrl, "_blank", "noopener,noreferrer");
      }
    } else {
      window.open(webUrl, "_blank", "noopener,noreferrer");
    }
    cleanup();
  }
}
