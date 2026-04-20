import { NextRequest, NextResponse } from "next/server";
import { updateItem, type EditablePatch } from "@/lib/data";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "type",
  "artist",
  "title",
  "label",
  "releaseDate",
  "description",
  "tags",
  "links",
  "coverImageUrl",
  "musicVideoUrl",
  "cover",
  "embed",
]);

// 64KB is comfortably more than an album description + embed config needs,
// and cheap to enforce. Stops someone from wedging a multi-MB payload through
// the admin session (which is already auth-gated by middleware, but defense
// in depth).
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }
  const body = (await req.json()) as { id?: string; patch?: Record<string, unknown> };
  if (!body.id || !body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "id and patch required" }, { status: 400 });
  }
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.patch)) {
    if (ALLOWED.has(k)) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) {
    return NextResponse.json({ error: "no editable fields" }, { status: 400 });
  }
  const updated = await updateItem(body.id, clean as EditablePatch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(updated);
}
