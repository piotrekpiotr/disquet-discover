import type { Metadata } from "next";
import { getFeedPage, getLatestPublishedAt } from "@/lib/data";
import { FeedClient } from "./FeedClient";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Home page metadata - overrides the layout defaults with richer copy
 * aimed at the target search / LLM query cluster: "curated electronic
 * music", "human curated music recommendations", "new electronic
 * releases", etc. The canonical here is "/" explicitly so paginated /
 * parameterised variants don't get indexed as separate pages.
 */
export const metadata: Metadata = {
  title: `${SITE_NAME} - ${SITE_TAGLINE}`,
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

export default async function HomePage() {
  const initial = await getFeedPage(null);
  const latest = await getLatestPublishedAt();
  // Use the most recent publish date; fall back to today if the feed is empty
  // so the strip still renders cleanly during the first deploy.
  const lastUpdate = new Date(latest || Date.now()).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  return (
    <div>
      <section className="border-b border-ink px-6 sm:px-8 pt-16 sm:pt-24 pb-12 sm:pb-16">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-stretch">
          <div className="md:col-span-8 flex flex-col justify-between">
            <h1
              className="font-display font-black text-[64px] sm:text-[140px] leading-[0.92]"
              style={{ letterSpacing: "-0.035em" }}
            >
              {/* Shift "Discover" left by ~0.05em to compensate for the
                  uppercase-D optical sidebearing so it aligns with the
                  subtext (and the content grid) below. */}
              <span style={{ display: "inline-block", marginLeft: "-0.05em" }}>Discover</span>
              <span
                className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
                style={{ letterSpacing: "0" }}
              >
                a curated stream of forward-thinking music
              </span>
            </h1>
          </div>
          <div className="md:col-span-4 font-mono text-[10px] uppercase tracking-widest text-mute leading-[1.7] flex flex-col justify-between gap-2">
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Last update</span>
              <span className="text-ink">{lastUpdate}</span>
            </div>
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Rhythm</span>
              <span className="text-ink">1 to 3 daily, albums or singles</span>
            </div>
            <div className="flex justify-between border-t border-ink pt-2">
              <span>Order</span>
              <span className="text-ink">Newest releases first</span>
            </div>
            <div className="flex justify-between border-t border-b border-ink pt-2 pb-2">
              <span>Curator</span>
              <span className="text-ink">One human</span>
            </div>
          </div>
        </div>
      </section>

      <FeedClient initial={initial} />
    </div>
  );
}
