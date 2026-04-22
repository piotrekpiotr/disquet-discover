import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/admin/newsletter-diag
 *
 * Admin-only diagnostic for the newsletter pipeline. Hits Buttondown's own
 * API with the server's key and reports back:
 *
 *   - Whether BUTTONDOWN_API_KEY is set.
 *   - Whether that key is accepted (a no-op call to /v1/newsletters).
 *   - Whether the account has a verified sending domain configured.
 *   - The most recent N subscribers so the curator can see whether their
 *     own test signup actually reached Buttondown and its current `type`
 *     (unactivated = confirmation email sent, waiting on click).
 *
 * Why this exists: when "I never got the confirmation email" comes in, the
 * question splits three ways — is the key set, did the subscriber get
 * created, did Buttondown try to deliver. Without this endpoint the curator
 * has to open Buttondown's own UI in another tab. With it, one click on
 * /admin/newsletter-diag tells them exactly where the pipeline broke.
 *
 * Auth: matched by middleware's PROTECTED_PREFIXES under /api/admin.
 */
export async function GET() {
  const key = process.env.BUTTONDOWN_API_KEY;
  const out: {
    hasKey: boolean;
    fromName: string | null;
    supportEmail: string | null;
    keyAccepted: boolean | null;
    apiError: string | null;
    newsletters: Array<{ username?: string; from_name?: string }> | null;
    recentSubscribers: Array<{
      email_address: string;
      type: string;
      creation_date?: string;
      tags?: string[];
    }> | null;
  } = {
    hasKey: Boolean(key),
    fromName: process.env.NEWSLETTER_FROM_NAME || null,
    supportEmail: process.env.NEWSLETTER_SUPPORT_EMAIL || null,
    keyAccepted: null,
    apiError: null,
    newsletters: null,
    recentSubscribers: null,
  };

  if (!key) {
    out.apiError = "BUTTONDOWN_API_KEY is not set on this server.";
    return NextResponse.json(out);
  }

  // Probe 1: /newsletters — returns the list of newsletters on the account.
  // Cheap and safe; confirms the key is accepted.
  try {
    const res = await fetch("https://api.buttondown.email/v1/newsletters", {
      headers: { Authorization: `Token ${key}` },
    });
    if (!res.ok) {
      out.keyAccepted = false;
      out.apiError = `Buttondown /newsletters returned ${res.status}: ${(await res.text()).slice(0, 240)}`;
      return NextResponse.json(out);
    }
    const json = (await res.json()) as {
      results?: Array<{ username?: string; from_name?: string }>;
    };
    out.keyAccepted = true;
    out.newsletters = json.results || [];
  } catch (e) {
    out.keyAccepted = false;
    out.apiError =
      "Network error reaching Buttondown: " +
      (e instanceof Error ? e.message : String(e));
    return NextResponse.json(out);
  }

  // Probe 2: /subscribers — latest first so the curator can see their own
  // test signup and its `type`. `type === "unactivated"` means Buttondown
  // accepted the subscriber and sent the confirmation email; if they never
  // get the email from that state, the issue is deliverability, not code.
  try {
    const res = await fetch(
      "https://api.buttondown.email/v1/subscribers?ordering=-creation_date&page_size=5",
      { headers: { Authorization: `Token ${key}` } },
    );
    if (res.ok) {
      const json = (await res.json()) as {
        results?: Array<{
          email_address: string;
          type: string;
          creation_date?: string;
          tags?: string[];
        }>;
      };
      out.recentSubscribers = (json.results || []).map((r) => ({
        email_address: r.email_address,
        type: r.type,
        creation_date: r.creation_date,
        tags: r.tags,
      }));
    }
  } catch {
    /* non-fatal; keep what we have */
  }

  return NextResponse.json(out);
}
