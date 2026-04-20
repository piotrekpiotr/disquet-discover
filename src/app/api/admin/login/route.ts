/**
 * POST /api/admin/login
 *
 * Body: { password: string, next?: string }
 * Success: 200 + Set-Cookie of the signed session. Body echoes { ok: true, next }.
 * Failure: 401 { error: "invalid" }.
 *
 * Deliberately does NOT leak whether the password is short / empty / etc -
 * only a single generic failure reply.
 *
 * Rate limiting: an in-memory fixed window per client IP caps brute-force
 * attempts at 10 per 10 minutes. Good enough on a single instance; swap
 * `@/lib/rate-limit` for a Redis-backed one when we scale horizontally.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  SESSION_TTL_MS,
  checkPassword,
  signSession,
} from "@/lib/admin-auth";
import { clientIp, take } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const verdict = take(`login:${ip}`, { limit: 10, windowMs: 10 * 60_000 });
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "too-many-requests" },
      { status: 429, headers: { "Retry-After": String(verdict.resetInSec) } },
    );
  }

  // Body-size guard: login payload is tiny. Reject anything over 4KB outright.
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 4096) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }

  let body: { password?: string; next?: string };
  try {
    body = (await req.json()) as { password?: string; next?: string };
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length === 0 || password.length > 256) {
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  const ok = await checkPassword(password);
  if (!ok) {
    // Tiny deterrent against script-kid brute-force. 500ms is invisible to a
    // human typing their password and slows an automated attempt meaningfully.
    await new Promise((r) => setTimeout(r, 500));
    return NextResponse.json({ error: "invalid" }, { status: 401 });
  }
  const token = await signSession();
  const res = NextResponse.json({ ok: true, next: body.next || "/admin" });
  res.cookies.set({
    name: ADMIN_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
