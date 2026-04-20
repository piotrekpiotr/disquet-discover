/**
 * Admin-only newsletter send trigger.
 *
 *   POST /api/newsletter/send
 *     -> { ok: true, sent: true, subject, recordCount, ids }
 *     -> { ok: true, sent: false, reason: "empty-queue" | "no-approved-records" }
 *     -> { error: "upstream" } on ESP failure
 *
 * Protected by the admin middleware — only a logged-in curator can trigger.
 * No CRON_SECRET header required; the session cookie is authority.
 *
 * Send is NOT idempotent at the HTTP layer: the queue state commits on
 * success, so repeat POSTs after success find an empty queue and return
 * `sent: false, reason: empty-queue`. That's the desired behavior.
 */
import { NextResponse } from "next/server";
import { sendQueuedNewsletter } from "@/lib/newsletter-send";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await sendQueuedNewsletter();
    return NextResponse.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("newsletter send failed:", err);
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }
}
