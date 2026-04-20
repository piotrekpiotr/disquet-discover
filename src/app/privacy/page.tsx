import type { Metadata } from "next";
import { SITE_NAME, SITE_CONTACT_EMAIL, SITE_URL } from "@/lib/site";

/**
 * Privacy policy page.
 *
 * Scope: this is a single-curator editorial site whose only personal-data
 * processing is the newsletter signup. Everything else is hand-crafted
 * editorial content with zero analytics, zero tracking, zero advertising.
 *
 * Legal basis (under RODO / GDPR):
 *   - Newsletter subscription: Art. 6(1)(a) GDPR, consent, expressed
 *     via the footer signup form + double opt-in confirmation click.
 *   - Hosting access logs: Art. 6(1)(f), legitimate interest in keeping
 *     the site running and investigating abuse. Retained max. 30 days.
 *
 * Controller address is kept minimal: for a natural person running a
 * non-commercial side project in Poland there is no legal duty to
 * publish a postal address unless the curator is also selling goods.
 * The moment a vinyl-store component goes live this page needs updating.
 */
export const metadata: Metadata = {
  title: "Privacy",
  description: `How ${SITE_NAME} handles personal data.`,
  alternates: { canonical: "/privacy" },
};

const UPDATED = "19 April 2026";

export default function PrivacyPage() {
  return (
    <article className="px-6 sm:px-8 py-12 sm:py-20 max-w-[72ch] mx-auto flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1
          className="font-display font-black text-[44px] sm:text-[64px] leading-[0.95]"
          style={{ letterSpacing: "-0.035em" }}
        >
          Privacy
          <span
            className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
            style={{ letterSpacing: "0" }}
          >
            what we collect and why
          </span>
        </h1>
        <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
          Last updated, {UPDATED}
        </p>
      </header>

      <Section title="Short version">
        <p>
          No analytics, no tracking pixels, no advertising. The only
          personal data we collect is the email address you give us if you
          subscribe to the newsletter.
        </p>
      </Section>

      <Section title="Data controller">
        <p>
          The controller for personal data processed through this site is
          the curator running {SITE_NAME}. Reach us at{" "}
          <a
            href={`mailto:${SITE_CONTACT_EMAIL}`}
            className="border-b border-ink hover:text-signal hover:border-signal"
          >
            {SITE_CONTACT_EMAIL}
          </a>
          . Postal address is provided on request.
        </p>
      </Section>

      <Section title="Newsletter">
        <p>
          When you subscribe to the weekly newsletter we collect your email
          address. The legal basis is your consent under Art. 6(1)(a) GDPR,
          expressed by submitting the signup form and clicking the link in
          the confirmation email we send you.
        </p>
        <p>
          Your email is stored with our email provider,{" "}
          <a
            href="https://buttondown.com"
            target="_blank"
            rel="noreferrer noopener"
            className="border-b border-ink hover:text-signal hover:border-signal"
          >
            Buttondown
          </a>{" "}
          (Buttondown LLC, USA). Buttondown is certified under the EU-US
          Data Privacy Framework and processes personal data on our behalf
          under a standard data-processing agreement. Every newsletter has
          a one-click unsubscribe link; you can also email us to be removed.
        </p>
        <p>
          We keep the email until you unsubscribe or ask us to delete it.
          We do not profile subscribers and we do not share the list.
        </p>
      </Section>

      <Section title="Embedded media players">
        <p>
          Record pages embed players from Bandcamp, Apple Music, Spotify,
          SoundCloud, YouTube, and Deezer. Those players set their own
          cookies once loaded. We don&apos;t load them until you click the
          consent banner, and you can reset that choice by clearing your
          browser&apos;s storage for this site.
        </p>
        <p>
          When a player is loaded, your interaction with it is governed by
          the provider&apos;s own privacy policy, not ours. Those providers
          may process your data outside the European Economic Area.
        </p>
      </Section>

      <Section title="Hosting logs">
        <p>
          Our hosting provider records standard web-server logs (IP
          address, user-agent, referrer, requested path, response code) for
          up to 30 days. This is Art. 6(1)(f) GDPR, legitimate interest in
          keeping the site running and dealing with abuse. We do not
          combine these logs with any other data.
        </p>
      </Section>

      <Section title="Saved records">
        <p>
          The &quot;saved&quot; list on{" "}
          <a href="/saved" className="border-b border-ink hover:text-signal">
            /saved
          </a>{" "}
          lives entirely in your browser&apos;s localStorage. We never see
          it. Clearing your browser data deletes it.
        </p>
      </Section>

      <Section title="Your rights">
        <p>
          Under RODO/GDPR you can access, rectify, erase, restrict, object
          to, and port any personal data we hold, and lodge a complaint
          with the Polish supervisory authority (Prezes Urzędu Ochrony
          Danych Osobowych,{" "}
          <a
            href="https://uodo.gov.pl"
            target="_blank"
            rel="noreferrer noopener"
            className="border-b border-ink hover:text-signal"
          >
            uodo.gov.pl
          </a>
          ). To exercise any of those rights, email{" "}
          <a
            href={`mailto:${SITE_CONTACT_EMAIL}`}
            className="border-b border-ink hover:text-signal"
          >
            {SITE_CONTACT_EMAIL}
          </a>
          . We try to respond within a week and have 30 days under the
          regulation.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, the &quot;last updated&quot; date at the
          top will change too.
        </p>
      </Section>

      <footer className="font-mono text-[10px] uppercase tracking-widest text-mute border-t border-ink pt-4">
        <a
          href="/"
          className="border-b border-mute hover:text-ink hover:border-ink"
        >
          Back to {SITE_URL.replace(/^https?:\/\//, "")}
        </a>
      </footer>
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
