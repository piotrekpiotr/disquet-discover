"use client";
import { resetConsent } from "@/lib/consent";

/**
 * Footer link that clears the stored consent choice. Resetting to "unset"
 * re-triggers the ConsentBanner (full version) so the visitor can
 * reconsider allow/decline at any time. Required by ePrivacy: once a user
 * has given or withheld consent, they must be able to withdraw or revise
 * it as easily as they gave it.
 */
export function CookiesResetLink() {
  return (
    <button
      type="button"
      onClick={() => resetConsent()}
      className="border-b border-transparent hover:text-ink hover:border-ink font-mono text-[10px] uppercase tracking-widest"
    >
      Cookies
    </button>
  );
}
