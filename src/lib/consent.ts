/**
 * Tiny consent state helper. Runs entirely in the browser; there is no
 * server-side cookie of our own - the only thing we need to remember is
 * "did the visitor agree to load third-party embeds (YouTube, Spotify,
 * Bandcamp, etc.)" because those iframes set their own tracking cookies
 * the moment they render.
 *
 * Storage: `localStorage["disquet_consent"]`. Values:
 *   - "accepted" - embeds render immediately.
 *   - "declined" - embeds stay behind a click-to-load card.
 *   - missing   - banner is shown; embeds stay behind the click-to-load
 *                 card until a choice is made.
 *
 * We purposely use localStorage not a cookie, because consent itself is
 * not a "strictly necessary" purpose that would justify a persistent
 * cookie pre-consent. LocalStorage under ePrivacy follows the same rule
 * as cookies, but the "strictly necessary" exception covers user-set
 * preferences (EDPB Guidelines 2/2023, section 3.2). Either way we only
 * store a single 8-byte string.
 *
 * An in-module pub/sub pattern lets EmbedPlayer re-render when consent
 * changes (click "Accept" -> every embed across the page lights up
 * without needing a full page reload).
 */

export type ConsentState = "accepted" | "declined" | "unset";

const KEY = "disquet_consent";
type Listener = (state: ConsentState) => void;
const listeners = new Set<Listener>();

/** Read current consent, safe on the server (returns "unset"). */
export function getConsent(): ConsentState {
  if (typeof window === "undefined") return "unset";
  const v = window.localStorage.getItem(KEY);
  if (v === "accepted" || v === "declined") return v;
  return "unset";
}

/** Persist a new consent value and notify subscribers. */
export function setConsent(next: Exclude<ConsentState, "unset">) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, next);
  // Same-tab notify (storage event only fires cross-tab).
  for (const l of listeners) l(next);
}

/** Clear the stored choice; banner re-appears, embeds go back to click-to-load. */
export function resetConsent() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
  for (const l of listeners) l("unset");
}

/** Subscribe to changes. Returns an unsubscribe fn. */
export function onConsentChange(cb: Listener): () => void {
  listeners.add(cb);
  const storage = (e: StorageEvent) => {
    if (e.key === KEY) cb(getConsent());
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", storage);
  }
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", storage);
    }
  };
}
