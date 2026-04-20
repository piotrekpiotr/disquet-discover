import type { Metadata } from "next";
import { SavedClient } from "./SavedClient";

/**
 * /saved is personal + user-specific, not editorial, so we explicitly
 * noindex it. There's nothing here a search engine or LLM crawler would
 * get value from - the content is whatever the current visitor has pinned.
 */
export const metadata: Metadata = {
  title: "Saved",
  robots: { index: false, follow: false },
  alternates: { canonical: "/saved" },
};

/**
 * /saved - the user's personal pin-board of records they've hit "Save" on.
 *
 * Favourites live in localStorage, so the item list has to be resolved on
 * the client. This server component renders only the static hero; the
 * SavedClient below hydrates with the user's IDs, fetches the full records
 * from /api/saved, and renders the same RecommendationCard the main feed
 * uses. The hero text is rewritten so this page clearly belongs to the
 * user, not to the global feed.
 */
export const dynamic = "force-dynamic";

export default function SavedPage() {
  return (
    <div>
      <section className="border-b border-ink px-6 sm:px-8 pt-16 sm:pt-24 pb-12 sm:pb-16">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-stretch">
          <div className="md:col-span-8 flex flex-col justify-between">
            <h1
              className="font-display font-black text-[64px] sm:text-[140px] leading-[0.92]"
              style={{ letterSpacing: "-0.035em" }}
            >
              {/* Single-word hero mirroring the home page's "Discover".
                  Negative marginLeft compensates for the uppercase-S
                  optical sidebearing so the "S" sits flush with the grid. */}
              <span style={{ display: "inline-block", marginLeft: "-0.04em" }}>Saved</span>
              <span
                className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
                style={{ letterSpacing: "0" }}
              >
                records you flagged to come back to
              </span>
            </h1>
          </div>
          <div className="md:col-span-4 font-mono text-[10px] uppercase tracking-widest text-mute leading-[1.7] flex flex-col justify-between gap-2">
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Storage</span>
              <span className="text-ink">This browser only</span>
            </div>
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Account</span>
              <span className="text-ink">None needed</span>
            </div>
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Order</span>
              <span className="text-ink">Release date, newest first</span>
            </div>
            <div className="flex justify-between border-t border-b border-ink pt-2 pb-2">
              <span>Remove</span>
              <span className="text-ink">Hit Saved on the card</span>
            </div>
          </div>
        </div>
      </section>

      <SavedClient />
    </div>
  );
}
