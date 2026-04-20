"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Fires the unsubscribe API once on mount, then shows a plain confirmation.
 * No retention funnel, no reason picker, no resubscribe offer.
 */
export function UnsubscribeClient({ email }: { email: string }) {
  const [status, setStatus] = useState<"pending" | "done" | "noemail">(
    email ? "pending" : "noemail",
  );

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    (async () => {
      try {
        await fetch(
          `/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}`,
          { method: "POST" },
        );
      } catch {
        /* swallow - see API route for rationale */
      }
      if (!cancelled) setStatus("done");
    })();
    return () => {
      cancelled = true;
    };
  }, [email]);

  if (status === "noemail") {
    return (
      <p className="font-body text-[15px] leading-[1.5] text-ink/80">
        This link needs an <code className="font-mono text-[12px]">email</code>{" "}
        query parameter to unsubscribe. Use the link from any of the newsletter
        emails - they include the right parameter automatically.
      </p>
    );
  }

  return (
    <>
      <p className="font-body text-[15px] leading-[1.5] text-ink/80">
        {status === "pending"
          ? "Removing you from the list..."
          : `${email} has been removed from the Disquet Discover mailing list. No more emails from us.`}
      </p>
      <p className="font-mono text-[10px] uppercase tracking-widest text-mute">
        Changed your mind? You can{" "}
        <Link
          href="/"
          className="text-ink border-b border-ink hover:border-signal hover:text-signal"
        >
          resubscribe from the footer
        </Link>
        .
      </p>
    </>
  );
}
