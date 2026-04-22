"use client";
import { useState } from "react";

/**
 * Footer signup widget. Single weekly newsletter — no cadence choice.
 *
 * UX:
 *   - The honeypot input `_trap` is visually hidden + aria-hidden; bots
 *     fill it, humans don't. The server rejects any submission with a
 *     non-empty value.
 *   - On success the form swaps to a short confirmation. Buttondown's
 *     double opt-in means the user still has to click a link in their
 *     inbox before they're subscribed - the copy reflects that honestly.
 *   - On failure we show a plain inline error (no red flash, no modal).
 *
 * GDPR / RODO consent:
 *   The dedicated checkbox below the email field is the site's "clear
 *   affirmative action" per Art. 4(11) GDPR. It is NOT pre-checked
 *   (pre-ticked boxes are explicitly disallowed under the regulation —
 *   see the CJEU Planet49 ruling, C-673/17) and is a hard requirement to
 *   submit. Submitting the form records that consent by the act of POST;
 *   Buttondown's confirmation click is the double-opt-in receipt.
 */
export function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "submitting" | "ok" | "error">(
    "idle",
  );
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const trap = (form.elements.namedItem("_trap") as HTMLInputElement)?.value || "";
    // Defensive: the checkbox has `required`, but also guard here in case
    // a browser extension bypasses HTML validation.
    if (!consent) {
      setErrMsg(
        "Please tick the consent box so we can send you the newsletter.",
      );
      setState("error");
      return;
    }
    setState("submitting");
    setErrMsg(null);
    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, _trap: trap }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setErrMsg(
          body.error === "invalid-email"
            ? "That doesn't look like a valid email."
            : "Couldn't sign you up right now. Try again in a minute.",
        );
        setState("error");
        return;
      }
      setState("ok");
    } catch {
      setErrMsg("Couldn't reach the server. Try again in a minute.");
      setState("error");
    }
  }

  if (state === "ok") {
    return (
      <div className="font-mono text-[10px] uppercase tracking-widest leading-[1.6] text-ink flex flex-col gap-1 sm:text-right max-w-sm sm:ml-auto">
        <div>You&apos;re almost in</div>
        <div className="text-mute normal-case tracking-normal font-body text-[12px] leading-[1.5]">
          Check your inbox for a confirmation link. Click it and the next
          weekly digest lands in your inbox.
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 font-mono text-[10px] uppercase tracking-widest text-mute sm:text-right"
      noValidate
    >
      <div className="text-ink">Weekly newsletter</div>

      <div className="flex gap-2 sm:justify-end">
        <label htmlFor="newsletter-email" className="sr-only">
          Email address
        </label>
        <input
          id="newsletter-email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@domain.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border border-ink bg-paper px-2 py-1.5 font-mono text-[11px] normal-case tracking-normal text-ink placeholder:text-mute/70 focus:outline-none focus:bg-paper-2/40 w-full sm:w-64"
        />
        {/*
          Honeypot. Real users don't see this. Bots that autofill every
          field will fill it and get silently dropped by the API. We use
          the WCAG "visually-hidden" pattern (clip-path + 1x1) instead of
          a negative-left absolute position — the latter used to push the
          document width out and cause a phantom horizontal scrollbar.
        */}
        <input
          type="text"
          name="_trap"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            clipPath: "inset(50%)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        />
        <button
          type="submit"
          disabled={state === "submitting" || !consent}
          className="border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state === "submitting" ? "..." : "Subscribe"}
        </button>
      </div>

      {/*
        GDPR / RODO consent. Required, never pre-checked (CJEU Planet49
        C-673/17 — pre-ticked boxes don't meet "unambiguous indication of
        the data subject's wishes"). Links to the privacy policy so the
        consent is informed. Kept visually subordinate to the email input
        so the form reads as one unit, not two steps.
      */}
      <label className="flex items-start gap-2 normal-case tracking-normal font-body text-[11px] leading-[1.45] text-mute sm:justify-end sm:text-right max-w-xs sm:ml-auto">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          required
          aria-describedby="newsletter-consent-copy"
          className="mt-[3px] accent-ink flex-shrink-0"
        />
        <span id="newsletter-consent-copy">
          I agree to receive the weekly newsletter and to my email being
          stored by{" "}
          <a
            href="https://buttondown.com"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-ink"
          >
            Buttondown
          </a>{" "}
          for that purpose. See the{" "}
          <a
            href="/privacy"
            className="underline underline-offset-2 hover:text-ink"
          >
            privacy policy
          </a>
          .
        </span>
      </label>

      {errMsg && (
        <div className="text-signal normal-case tracking-normal font-body text-[12px]">
          {errMsg}
        </div>
      )}

      <div className="text-mute normal-case tracking-normal font-body text-[11px] leading-[1.5] sm:text-right">
        One email a week. Double opt-in, one-click unsubscribe. No tracking
        pixels, no third-party list sharing.
      </div>
    </form>
  );
}
