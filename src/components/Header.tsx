"use client";
import Link from "next/link";
import { DotsMark } from "./DotsMark";
import { useFavorites } from "./FavoriteButton";

/**
 * Sticky site header. "Saved" is always a real link to /saved:
 *   - zero saved items  → link with no badge; the /saved page itself shows
 *     a friendly "Nothing saved yet" empty state and a pointer back to the
 *     feed.
 *   - one or more saved → link with a count badge.
 *
 * It used to render as a non-clickable <span> in the empty state. Problem:
 * favourites live in localStorage (see FavoriteButton). The hook returns []
 * on the server AND on the first client paint — it only picks up real data
 * after the client-side effect runs. So a visitor clicking "Saved" right
 * after hitting Save would sometimes hit the static span (no navigation),
 * then the count would hydrate to 1, then the next click would work but
 * land on an already-empty /saved because the navigation had effectively
 * been a no-op. Always rendering a link makes the target reachable in one
 * click, and /saved handles every state itself.
 */
export function Header() {
  const { favorites } = useFavorites();
  const count = favorites.length;

  return (
    <header className="sticky top-0 z-50 bg-paper border-b border-ink">
      <div className="flex items-center justify-between px-6 sm:px-8 py-3.5">
        <Link href="/" className="flex items-center gap-3 no-underline text-ink">
          <DotsMark size={26} />
          <span className="flex items-baseline gap-2">
            <span
              className="font-display font-black text-[18px] leading-none"
              style={{ letterSpacing: "-0.02em" }}
            >
              Disquet
            </span>
            <span className="font-serif italic text-mute text-[14px] leading-none hidden sm:inline">
              discover
            </span>
          </span>
        </Link>
        <nav className="flex items-center gap-5 sm:gap-7 font-mono text-[10px] sm:text-[11px] uppercase tracking-wider whitespace-nowrap">
          <Link href="/" className="hover:underline underline-offset-4 shrink-0">
            Feed
          </Link>
          <SavedNavItem count={count} />
          <Link href="/about" className="hover:underline underline-offset-4 shrink-0">
            About
          </Link>
          {/* Admin is intentionally NOT linked from the public nav. The
              curator reaches it by typing /admin directly; unauthenticated
              hits are bounced to /admin/login by the edge middleware, and
              every admin path is disallowed in robots.txt. Keeping it off
              the public nav avoids surfacing an attack target to crawlers
              and casual visitors. */}
        </nav>
      </div>
    </header>
  );
}

function SavedNavItem({ count }: { count: number }) {
  // Always a real link. The /saved page renders its own empty state when
  // nothing is saved; routing is the header's job, not gating.
  return (
    <Link
      href="/saved"
      className="hover:underline underline-offset-4 flex items-baseline gap-1 shrink-0"
    >
      Saved
      {count > 0 && (
        // tabular-nums keeps 1 / 10 / 100 / 1000 at a consistent digit width,
        // so the following nav items don't shift as the count grows.
        <span
          className="text-mute text-[9px] tabular-nums"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          ({count})
        </span>
      )}
    </Link>
  );
}
