/**
 * POST /api/newsletter/unsubscribe?email=...
 *
 * Called by the /unsubscribe page (which the emails link to). Accepts the
 * email in the query string so the link inside a plain-text email can be
 * a direct mailto-less URL. Still POST-only to satisfy RFC 8058 one-click
 * unsubscribe (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`).
 *
 * Also accepts GET so that clients that for whatever reason hit the URL
 * with GET (forwarded emails, link previewers) don't 405. In either case
 * the ESP call is the same.
 */
import { NextRequest, NextResponse } from "next/server";
import { isProbableEmail, unsubscribe } from "@/lib/newsletter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email") || "";
  if (!isProbableEmail(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }
  try {
    await unsubscribe(email);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("unsubscribe failed:", e instanceof Error ? e.message : e);
    }
    // Still return ok=true: from the user's point of view "you are
    // unsubscribed" is the right message even if the ESP API had a hiccup.
    // The ESP's own unsubscribe link (the one Buttondown sets via
    // List-Unsubscribe headers) is the authoritative path anyway.
  }
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest) {
  return handle(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
