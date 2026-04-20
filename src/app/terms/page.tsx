import type { Metadata } from "next";
import { SITE_NAME, SITE_CONTACT_EMAIL } from "@/lib/site";

/**
 * Terms of service page.
 *
 * Scope: editorial website with a free newsletter. No paid services, no
 * user-generated content, no accounts. The terms are short because the
 * surface area is small. The moment a vinyl store or any other paid
 * product ships, this page needs a consumer-rights section (prawo
 * odstąpienia, regulamin sklepu) and must be revised.
 */
export const metadata: Metadata = {
  title: "Terms",
  description: `Terms of use for ${SITE_NAME}.`,
  alternates: { canonical: "/terms" },
};

const UPDATED = "19 April 2026";

export default function TermsPage() {
  return (
    <article className="px-6 sm:px-8 py-12 sm:py-20 max-w-[72ch] mx-auto flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1
          className="font-display font-black text-[44px] sm:text-[64px] leading-[0.95]"
          style={{ letterSpacing: "-0.035em" }}
        >
          Terms
          <span
            className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
            style={{ letterSpacing: "0" }}
          >
            how you can use this site
          </span>
        </h1>
        <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
          Last updated, {UPDATED}
        </p>
      </header>

      <Section title="What this site is">
        <p>
          {SITE_NAME} is a personal editorial project: a hand-curated daily
          stream of new music recommendations and an optional email
          newsletter. The site is provided free of charge, without
          warranty, for personal use.
        </p>
      </Section>

      <Section title="Editorial content">
        <p>
          The written descriptions, selection, and layout copy on {SITE_NAME}{" "}
          are the curator&apos;s work and protected by copyright. Release
          metadata (artist, title, label, release date, cover image) belongs
          to the respective rights holders and appears here under fair-use
          editorial quotation.
        </p>
        <p>
          Link to any page, quote short passages with attribution, share the
          newsletter with friends. Don&apos;t republish the full
          descriptions elsewhere without permission, and don&apos;t scrape
          the site at volumes that affect its performance.
        </p>
      </Section>

      <Section title="Newsletter">
        <p>
          Subscribing to the newsletter is free. We send one weekly email.
          Every email has a one-click unsubscribe link and you can also
          email{" "}
          <a
            href={`mailto:${SITE_CONTACT_EMAIL}`}
            className="border-b border-ink hover:text-signal hover:border-signal"
          >
            {SITE_CONTACT_EMAIL}
          </a>{" "}
          to be removed. See the{" "}
          <a href="/privacy" className="border-b border-ink hover:text-signal">
            privacy policy
          </a>{" "}
          for how your email is stored.
        </p>
      </Section>

      <Section title="Third-party players">
        <p>
          Embedded audio and video players come from third-party services
          (Bandcamp, Apple Music, Spotify, SoundCloud, YouTube, Deezer).
          Your use of those players is governed by the respective
          service&apos;s terms, not ours. We are not responsible for the
          availability, behaviour, or content of third-party players.
        </p>
      </Section>

      <Section title="No warranty">
        <p>
          {SITE_NAME} is provided &quot;as is&quot;. We don&apos;t promise
          uptime, we don&apos;t promise that a given release stays on the
          public feed, and we don&apos;t promise that streaming services
          keep a given album in their catalogue. To the extent allowed by
          Polish law, we disclaim liability for indirect or consequential
          damages arising from use of the site.
        </p>
      </Section>

      <Section title="Governing law">
        <p>
          Polish law applies. If you are a consumer in the European Union
          your mandatory consumer rights are not affected by anything in
          these terms. Disputes that can&apos;t be resolved by email go to
          the courts competent for the curator&apos;s place of residence.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If these terms change materially, we&apos;ll note the new
          &quot;last updated&quot; date at the top. Continuing to use{" "}
          {SITE_NAME} after a change means you accept the new version.
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display font-bold text-[20px] tracking-tight">
        {title}
      </h2>
      <div className="font-body text-[15px] leading-relaxed text-ink/90 flex flex-col gap-3">
        {children}
      </div>
    </section>
  );
}
