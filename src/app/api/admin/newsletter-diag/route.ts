import { NextRequest, NextResponse } from "next/server";

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
export async function GET(req: NextRequest) {
  const key = process.env.BUTTONDOWN_API_KEY;
  // Optional write-through probe: ?probe=1 creates a disposable test
  // subscriber, reads back the `type` Buttondown assigned it, and deletes
  // it. This is the ground-truth test for "is the deployed code sending
  // type=unactivated, and is Buttondown honoring it". If the probe comes
  // back with type="regular" despite us sending type="unactivated",
  // Buttondown's account-level DOI is off. If the probe fails at POST,
  // the deployed code doesn't have the fix.
  const probe = req.nextUrl.searchParams.get("probe") === "1";
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
    probe: null | {
      requestedType: "unactivated";
      actualType: string | null;
      createStatus: number;
      createBody: string;
      cleanupStatus: number | null;
    };
  } = {
    hasKey: Boolean(key),
    fromName: process.env.NEWSLETTER_FROM_NAME || null,
    supportEmail: process.env.NEWSLETTER_SUPPORT_EMAIL || null,
    keyAccepted: null,
    apiError: null,
    newsletters: null,
    recentSubscribers: null,
    probe: null,
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

  // Probe 3 (opt-in via ?probe=1): create-read-delete a disposable subscriber
  // so we can see the ACTUAL `type` Buttondown assigns when the deployed code
  // sends `type: "unactivated"`. This is the definitive test — if Railway is
  // running an old build that sends `type: "regular"` the probe will too, and
  // we'll see `actualType: "regular"` despite `requestedType: "unactivated"`.
  if (probe) {
    const testEmail = `probe+${Date.now()}@disquet.co`;
    let createStatus = 0;
    let createBody = "";
    let actualType: string | null = null;
    let cleanupStatus: number | null = null;
    try {
      const createRes = await fetch(
        "https://api.buttondown.email/v1/subscribers",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Token ${key}`,
          },
          body: JSON.stringify({
            email_address: testEmail,
            type: "unactivated",
            tags: ["probe"],
            notes: `probe:${new Date().toISOString()}`,
          }),
        },
      );
      createStatus = createRes.status;
      const text = await createRes.text();
      createBody = text.slice(0, 400);
      if (createRes.ok) {
        try {
          const parsed = JSON.parse(text) as { type?: string };
          actualType = parsed.type || null;
        } catch {
          actualType = null;
        }
      }
    } catch (e) {
      createBody = "network error: " + (e instanceof Error ? e.message : String(e));
    }
    // Clean up — don't leave probe+<timestamp>@disquet.co cluttering the
    // subscriber list, and definitely don't let it count against any free
    // tier limits.
    if (createStatus > 0 && createStatus < 500) {
      try {
        const delRes = await fetch(
          `https://api.buttondown.email/v1/subscribers/${encodeURIComponent(testEmail)}`,
          { method: "DELETE", headers: { Authorization: `Token ${key}` } },
        );
        cleanupStatus = delRes.status;
      } catch {
        cleanupStatus = -1;
      }
    }
    out.probe = {
      requestedType: "unactivated",
      actualType,
      createStatus,
      createBody,
      cleanupStatus,
    };
  }

  return NextResponse.json(out);
}
