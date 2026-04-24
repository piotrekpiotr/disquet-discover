"use client";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Links } from "@/lib/types";
import { buildAppUrl, detectPlatform, type Platform } from "@/lib/music-links";

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

    // Claim a fallback tab while the user gesture is still valid. Opening
    // from inside setTimeout would be popup-blocked on most browsers.
    const fallbackTab = window.open("", "_blank");

    let finished = false;
    const cleanup = () => {
      finished = true;
      inFlightRef.current = false;
      document.removeEventListener("visibilitychange", onVis);
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        // App opened → browser backgrounded this tab. Close the still-empty
        // fallback tab so the user doesn't return to a blank page.
        clearTimeout(timer);
        if (fallbackTab && !fallbackTab.closed) {
          try {
            fallbackTab.close();
          } catch {
            // Some browsers refuse to close tabs they didn't open; swallow.
          }
        }
        cleanup();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    const timer = window.setTimeout(() => {
      if (finished) return;
      // Still visible after FALLBACK_MS → app didn't open. Point the
      // pre-opened tab at the website.
      if (fallbackTab && !fallbackTab.closed) {
        try {
          fallbackTab.location.href = webUrl;
        } catch {
          // Cross-origin shenanigans — open a brand new tab as a last
          // resort. On browsers that blocked the pre-open, this is the
          // only path that's left anyway.
          window.open(webUrl, "_blank", "noopener,noreferrer");
        }
      } else {
        window.open(webUrl, "_blank", "noopener,noreferrer");
      }
      cleanup();
    }, FALLBACK_MS);

    // Kick the OS protocol handler. Using window.location on the current
    // tab (not an iframe) because Chromium blocks iframe navigations to
    // custom schemes. If the scheme is registered, the app opens and the
    // current tab is backgrounded (onVis fires). If it isn't, modern
    // browsers don't navigate away; our fallback handles that case.
    try {
      window.location.href = appUrl;
    } catch {
      // If setting location throws for some reason, fall back immediately.
      clearTimeout(timer);
      if (fallbackTab && !fallbackTab.closed) {
        try {
          fallbackTab.location.href = webUrl;
        } catch {
          window.open(webUrl, "_blank", "noopener,noreferrer");
        }
      }
      cleanup();
    }
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
