/**
 * Admin-only newsletter queue controls.
 *
 *   GET /api/newsletter/queue
 *     -> { queued: string[], sent: string[], max: number }
 *     Used by AdminClient to render per-record checkbox state and the
 *     header counter.
 *
 *   POST /api/newsletter/queue
 *     body: { id: string, action: "add" | "remove" }
 *     -> { ok: true, state } on success
 *        { error: "full" | "already-sent" | "already-queued" } otherwise
 *
 * Protected by the admin middleware (see src/middleware.ts). The middleware
 * matcher includes /api/newsletter/queue; unauthenticated requests get 401.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  MAX_QUEUE,
  addToQueue,
  readQueueState,
  removeFromQueue,
} from "@/lib/newsletter-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await readQueueState();
  return NextResponse.json({
    queued: state.queued,
    sent: state.sent,
    max: MAX_QUEUE,
  });
}

export async function POST(req: NextRequest) {
  let body: { id?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "id-required" }, { status: 400 });
  }
  if (body.action !== "add" && body.action !== "remove") {
    return NextResponse.json({ error: "invalid-action" }, { status: 400 });
  }

  if (body.action === "remove") {
    const state = await removeFromQueue(body.id);
    return NextResponse.json({
      ok: true,
      state: { queued: state.queued, sent: state.sent, max: MAX_QUEUE },
    });
  }

  const res = await addToQueue(body.id);
  if (!res.ok) {
    const status = res.reason === "full" ? 409 : 400;
    return NextResponse.json({ error: res.reason }, { status });
  }
  return NextResponse.json({
    ok: true,
    state: { queued: res.state.queued, sent: res.state.sent, max: MAX_QUEUE },
  });
}
