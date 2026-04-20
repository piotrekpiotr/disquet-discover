import type { Metadata } from "next";
import { UnsubscribeClient } from "./UnsubscribeClient";

/**
 * /unsubscribe - lands here from an email's unsubscribe link.
 *
 * The page reads `?email=` from the URL and calls the unsubscribe API
 * once, client-side. No "are you sure?" dialog, no "what went wrong?"
 * survey - the user asked to leave, we honour it instantly.
 *
 * noindex because this page only matters when reached via an email link.
 */
export const metadata: Metadata = {
  title: "Unsubscribed",
  robots: { index: false, follow: false },
};

export default function UnsubscribePage({
  searchParams,
}: {
  searchParams: { email?: string };
}) {
  const email = (searchParams?.email || "").trim();
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md border border-ink px-6 py-10 flex flex-col gap-5">
        <h1
          className="font-display font-black text-[44px] leading-[0.95]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Unsubscribed
          <span
            className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
            style={{ letterSpacing: "0" }}
          >
            you&apos;re off the list
          </span>
        </h1>
        <UnsubscribeClient email={email} />
      </div>
    </div>
  );
}
