import { NewsletterSignup } from "./NewsletterSignup";
import { CookiesResetLink } from "./CookiesResetLink";

/**
 * Global footer. Three columns on desktop, top-to-bottom on mobile:
 *   1. Meta block (contact, curator note, links) — left, left-aligned
 *   2. Social icons — middle
 *   3. Newsletter signup — right
 *
 * Icons are inline SVG using `currentColor` so they inherit the palette
 * and match the site's mute-to-ink hover treatment.
 */
export function Footer() {
  return (
    <footer className="border-t border-ink">
      <div className="px-6 sm:px-8 py-10 flex flex-col gap-10 sm:flex-row sm:items-end sm:justify-between">
        <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex flex-col gap-1 text-left">
          <div>Contact: hello@disquet.co</div>
          <div>Curation by one human</div>
          <div>Updated daily</div>
          <div className="pt-2 flex gap-3">
            <a
              href="/privacy"
              className="border-b border-transparent hover:text-ink hover:border-ink"
            >
              Privacy
            </a>
            <a
              href="/terms"
              className="border-b border-transparent hover:text-ink hover:border-ink"
            >
              Terms
            </a>
            <CookiesResetLink />
          </div>
        </div>

        <div className="flex items-end gap-5 text-mute sm:justify-center">
          <a
            href="https://www.instagram.com/disquet.co"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Disquet on Instagram"
            title="Instagram"
            className="hover:text-ink transition-colors inline-flex items-center justify-center"
          >
            <InstagramIcon />
          </a>
          <a
            href="https://bsky.app/profile/disquet.bsky.social"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Disquet on Bluesky"
            title="Bluesky"
            className="hover:text-ink transition-colors inline-flex items-center justify-center"
          >
            <BlueskyIcon />
          </a>
        </div>

        <NewsletterSignup />
      </div>
    </footer>
  );
}

/**
 * Instagram glyph. Hand-tuned 24-pt square: square frame with rounded corners,
 * camera-lens circle, small viewfinder dot. Uses `currentColor` on strokes
 * (no fills) so it lives in the same visual register as the site's hairline
 * rules and typography.
 */
function InstagramIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.3" cy="6.7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Bluesky butterfly / kite glyph. The official mark is a stylised butterfly
 * built from two overlapping curved triangles; we render a simplified outline
 * version so it looks at home next to the Instagram glyph (same weight, same
 * currentColor treatment).
 */
function BlueskyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6.2 4.7c2.6 1.9 5.4 5.8 6.4 8 1-2.2 3.8-6.1 6.4-8 1.9-1.3 4.9-2.4 4.9 1.1 0 .7-.4 5.8-.6 6.7-.7 3-3.9 3.7-6.7 3.2 5 .8 6.2 3.6 3.5 6.4-5.2 5.3-7.5-1.3-8.1-3-.1-.3-.2-.5-.2-.4 0-.1-.1.1-.2.4-.6 1.7-2.9 8.3-8.1 3-2.7-2.8-1.5-5.6 3.5-6.4-2.8.5-6 .2-6.7-3.2-.2-.9-.6-6-.6-6.7 0-3.5 3-2.4 4.9-1.1z" />
    </svg>
  );
}
