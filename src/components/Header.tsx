"use client";
import Link from "next/link";
import { DotsMark } from "./DotsMark";
import { useFavorites } from "./FavoriteButton";

/**
 * Sticky site header. The "Saved" nav item is context-aware:
 *   - zero saved items  → rendered as a muted, non-clickable span with an
 *     on-hover tooltip explaining where saved records will appear.
 *   - one or more saved → rendered as a live link to /saved with a count
 *     badge and the standard hover underline.
 *
 * Favourites live in localStorage (see FavoriteButton) so this component
 * must be client-rendered. The hook returns [] on the server / first
 * paint, which means SSR always sees the empty state - fine, it hydrates
 * on the client with the real count.
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
  if (count > 0) {
    return (
      <Link
        href="/saved"
        className="hover:underline underline-offset-4 flex items-baseline gap-1 shrink-0"
      >
        Saved
        {/* tabular-nums keeps 1 / 10 / 100 / 1000 at a consistent digit width,
            so the following nav items don't shift as the count grows. */}
        <span
          className="text-mute text-[9px] tabular-nums"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          ({count})
        </span>
      </Link>
    );
  }
  // Empty state: muted, unclickable, tooltip on hover.
  return (
    <span className="relative group text-mute cursor-help select-none shrink-0">
      Saved
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full right-0 mt-3 w-64 bg-ink text-paper px-3 py-2 font-mono text-[9px] normal-case tracking-wider leading-[1.5] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150 z-50"
      >
        Nothing here yet. Hit <span className="uppercase tracking-widest">Save</span> on a record and it&apos;ll land here for you to come back to.
      </span>
    </span>
  );
}
