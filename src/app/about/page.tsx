import type { Metadata } from "next";
import { aboutFaqNode, jsonLdScript } from "@/lib/structured-data";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

/**
 * Dedicated metadata for /about. The description here is tighter than the
 * site default and targets "about"-style questions LLMs get asked about
 * editorial projects ("who runs Disquet Discover", "how does Disquet
 * Discover pick its music").
 */
export const metadata: Metadata = {
  title: "About",
  description: `About ${SITE_NAME} - ${SITE_DESCRIPTION}`,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <div className="px-6 sm:px-8 pt-16 sm:pt-24 pb-24 max-w-4xl">
      {/* FAQPage JSON-LD - gives Google + LLM crawlers clean Q/A pairs to
          quote, and unlocks the "People also ask" rich result on the SERP. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(aboutFaqNode()) }}
      />
      <h1 className="font-display font-black text-[64px] sm:text-[120px] leading-[0.88] tracking-tightest">
        About
        {/* Italic serif subtitle, standardised: text-[0.34em] + leading-[1.25] + mt-1.
            letterSpacing:0 is REQUIRED: the parent h1 sets tracking-tightest
            (-0.05em), which inherits into this span and makes the italic
            serif letters bunch up / overlap. Reset to 0 here. */}
        <span
          className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
          style={{ letterSpacing: "0" }}
        >
          what this is, how it works
        </span>
      </h1>

      <div className="mt-12 grid grid-cols-1 md:grid-cols-12 gap-10">
        <div className="md:col-span-8 space-y-6 font-body text-[18px] leading-[1.55]">
          <p>
            <strong className="font-display font-black">Disquet Discover</strong>{" "}
            is a daily stream of new electronic and alternative music - one to
            three recommendations a day, albums or singles, ordered newest
            first. The lane is leftfield: IDM, ambient, dub techno, broken
            club, experimental, alternative. Think lineups of Berlin Atonal or
            Unsound Festival.
          </p>
          <p>
            Every release is hand-picked. A pool of new arrivals is filtered
            down to a small published set - what you see here is the curated
            part. No algorithm. If something gets in, it&apos;s because it
            earned the slot.
          </p>
          <p>
            Save anything you want to come back to. The list lives in your
            browser only - no account, no email, no tracking. Clear your
            storage and it&apos;s gone.
          </p>
        </div>

        <aside className="md:col-span-4 font-mono text-[11px] uppercase tracking-widest leading-[1.7] text-mute">
          <div className="border-t border-ink pt-2 mt-0 flex justify-between">
            <span>Frequency</span>
            <span className="text-ink">Daily</span>
          </div>
          <div className="border-t border-ink pt-2 mt-2 flex justify-between">
            <span>Per day</span>
            <span className="text-ink">1 to 3</span>
          </div>
          <div className="border-t border-ink pt-2 mt-2 flex justify-between">
            <span>Account</span>
            <span className="text-ink">Not required</span>
          </div>
          <div className="border-t border-ink pt-2 mt-2 flex justify-between">
            <span>Contact</span>
            <a
              href="mailto:hello@disquet.co"
              className="text-ink border-b border-ink"
            >
              hello@disquet.co
            </a>
          </div>
          <div className="border-t border-b border-ink pt-2 mt-2 pb-2 flex justify-between">
            <span>Sister project</span>
            <span className="text-ink">Disquet store</span>
          </div>
        </aside>
      </div>
    </div>
  );
}
