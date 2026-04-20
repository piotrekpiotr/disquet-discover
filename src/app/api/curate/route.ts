/**
 * POST /api/curate
 *
 * Body: { id: string, status: "pending" | "approved" | "rejected" }
 *
 * Updates a single record's moderation status. Pure write — no newsletter
 * side-effect anymore. Newsletter sending is manual, triggered separately
 * from the admin panel via POST /api/newsletter/send.
 */
import { NextRequest, NextResponse } from "next/server";
import { setStatus } from "@/lib/data";
import type { Status } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { id?: string; status?: Status };
  if (!body.id || !body.status) {
    return NextResponse.json({ error: "id and status required" }, { status: 400 });
  }
  if (!["pending", "approved", "rejected"].includes(body.status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const updated = await setStatus(body.id, body.status);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json(updated);
}
