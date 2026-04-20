/**
 * POST /api/newsletter/subscribe
 *
 * Body: { email: string, _trap?: string }
 *
 * Flow:
 *   1. Validate email shape.
 *   2. Honeypot: a hidden `_trap` field in the form. Real users leave it
 *      empty; most automated scrapers fill every field. Non-empty = 202
 *      success (to not tip off the bot) with no ESP call.
 *   3. Call the ESP. Buttondown's double opt-in (account-level setting)
 *      handles the confirmation email - we don't mint a token ourselves.
 *   4. Return { ok: true }. The client shows a generic "check your inbox"
 *      reply regardless of whether the email was already subscribed, so
 *      the endpoint can't be used to enumerate subscriber state.
 *
 * Deliberately NOT auth-gated and NOT CSRF-tokened: a public signup
 * endpoint is meant to be POSTable from anywhere. We rely on:
 *   - Honeypot (cheap but effective against commodity bots).
 *   - Strict input validation.
 *   - ESP double opt-in (a malicious POST just triggers a single
 *     confirmation email to the victim, who doesn't click - no subscribe).
 *   - Length caps below.
 */
import { NextRequest, NextResponse } from "next/server";
import { isProbableEmail, subscribe } from "@/lib/newsletter";
import { clientIp, take } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  // IP cap: 5 signups per IP per hour. Matches "family sharing a NAT" upper
  // bound while shutting down spray attacks.
  const ipVerdict = take(`subscribe:ip:${ip}`, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  if (!ipVerdict.allowed) {
    return NextResponse.json(
      { error: "too-many-requests" },
      { status: 429, headers: { "Retry-After": String(ipVerdict.resetInSec) } },
    );
  }

  // Body-size guard. Subscribe payload is tiny.
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 4096) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }

  let body: { email?: string; _trap?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Honeypot. Return 202 so the bot thinks the submission worked.
  if (typeof body._trap === "string" && body._trap.length > 0) {
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  if (!isProbableEmail(body.email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }

  // Email cap: 2 attempts per address per hour regardless of source IP, so an
  // attacker can't bounce a victim's inbox through a botnet of addresses.
  const emailVerdict = take(`subscribe:email:${body.email.toLowerCase()}`, {
    limit: 2,
    windowMs: 60 * 60_000,
  });
  if (!emailVerdict.allowed) {
    // Mimic the success path so we don't leak that this address is rate-limited.
    return NextResponse.json({ ok: true });
  }

  try {
    await subscribe(body.email);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    // Generic response - don't leak provider details.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("subscribe failed:", msg);
    }
    return NextResponse.json({ error: "upstream" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
