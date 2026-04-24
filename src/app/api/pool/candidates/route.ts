import { NextRequest, NextResponse } from "next/server";
import {
  CandidateRow,
  listCandidates,
  markDismissed,
  markPromoted,
} from "@/lib/media-candidates";
import { addExtra } from "@/lib/monitoring-extras";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin endpoints for the media-driven candidate pool.
 *
 *   GET  /api/pool/candidates            → { candidates: CandidateRow[] }
 *   POST /api/pool/candidates            body: { name, action: "promote"|"dismiss" }
 *
 * `promote` adds the artist to monitoring-extras AND marks the candidate
 * promoted so it disappears from the review list. `dismiss` only marks
 * the candidate, no side-effects.
 *
 * Lives under /api/pool so middleware protects it. The sync-media.mjs
 * workflow step writes to data/media-candidates.json directly on disk;
 * it does not hit this endpoint.
 */
export async function GET() {
  try {
    const candidates: CandidateRow[] = await listCandidates();
    return NextResponse.json({ candidates });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  let body: { name?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { name?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const action = typeof body.action === "string" ? body.action : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  if (action !== "promote" && action !== "dismiss") {
    return NextResponse.json(
      { error: "action must be 'promote' or 'dismiss'" },
      { status: 400 },
    );
  }
  try {
    if (action === "promote") {
      // Two-step: add to monitoring-extras AND mark candidate promoted.
      // If the monitoring add fails we surface the error before touching
      // the candidate file, so the button stays clickable for a retry.
      await addExtra("artist", name);
      await markPromoted(name);
      return NextResponse.json({ ok: true, action: "promote" });
    }
    await markDismissed(name);
    return NextResponse.json({ ok: true, action: "dismiss" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 },
    );
  }
}
