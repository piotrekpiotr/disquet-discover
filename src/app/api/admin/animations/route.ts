/**
 * Admin endpoints for managing reel background animations.
 *
 * GET  /api/admin/animations          — list { files: string[], dir: string }
 * POST /api/admin/animations          — upload one file (multipart/form-data, field "file")
 * DELETE /api/admin/animations?name=  — remove one file by name
 *
 * Storage:
 *   Files live on the Railway persistent volume at
 *   `<cwd>/data/animations/`. Local dev also accepts files at the
 *   user's original `animation backgrounds/` folder via the lookup
 *   in reel-counter.ts; uploads always land in the canonical location.
 *
 * Filename rule:
 *   `NN. <slug>.mp4` — two-digit zero-padded prefix + literal dot +
 *   space + free-form slug + `.mp4`. The cycle iterator sorts by
 *   filename, so the prefix determines cycle order. Files that
 *   don't match the pattern are rejected on upload to avoid the
 *   cycler getting confused.
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ANIMATIONS_PRIMARY_DIR,
  listAvailableAnimations,
} from "@/lib/reel-counter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILENAME_RE = /^\d{2}\.\s.+\.mp4$/i;
// 80 MB — the largest of the 30 known animations is ~56 MB, so 80 MB
// gives a comfortable headroom without letting some accidentally-
// huge file blow up the volume.
const MAX_BYTES = 80 * 1024 * 1024;

export async function GET() {
  const { dir, files } = await listAvailableAnimations();
  // Return sizes alongside names so the UI can show a friendly list.
  const out = await Promise.all(
    files.map(async (name) => {
      try {
        const st = await fs.stat(path.join(dir, name));
        return { name, size: st.size };
      } catch {
        return { name, size: 0 };
      }
    }),
  );
  return NextResponse.json({ dir, files: out });
}

export async function POST(req: NextRequest) {
  // Next.js' Edge-style FormData parsing works in the Node runtime
  // for multipart bodies, no extra dependency needed.
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { error: "invalid multipart body", detail: String(e) },
      { status: 400 },
    );
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: "file field missing or not a file" },
      { status: 400 },
    );
  }
  // formData files carry their original filename on the Blob.
  // We need that to enforce the `NN. name.mp4` pattern.
  const rawName =
    typeof (file as Blob & { name?: string }).name === "string"
      ? (file as Blob & { name: string }).name
      : "";
  const cleanName = rawName.replace(/[/\\]/g, "").trim();
  if (!cleanName) {
    return NextResponse.json(
      { error: "file has no filename" },
      { status: 400 },
    );
  }
  if (!FILENAME_RE.test(cleanName)) {
    return NextResponse.json(
      {
        error: `filename must match "NN. slug.mp4" (got "${cleanName}")`,
      },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: `file too large (${file.size} bytes > ${MAX_BYTES} cap)`,
      },
      { status: 413 },
    );
  }

  // Ensure target dir exists. mkdir -p is no-op when it already does.
  await fs.mkdir(ANIMATIONS_PRIMARY_DIR, { recursive: true });
  const target = path.join(ANIMATIONS_PRIMARY_DIR, cleanName);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(target, buf);
  return NextResponse.json({ ok: true, name: cleanName, size: buf.length });
}

export async function DELETE(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name || !FILENAME_RE.test(name)) {
    return NextResponse.json(
      { error: "name query param required and must match pattern" },
      { status: 400 },
    );
  }
  const target = path.join(ANIMATIONS_PRIMARY_DIR, name);
  // Refuse to delete anything outside the primary dir (defence
  // against ../ in the query string even though FILENAME_RE
  // already rejects slashes).
  if (!target.startsWith(ANIMATIONS_PRIMARY_DIR + path.sep)) {
    return NextResponse.json(
      { error: "path escapes animations dir" },
      { status: 400 },
    );
  }
  try {
    await fs.unlink(target);
  } catch (e) {
    return NextResponse.json(
      { error: "delete failed", detail: String(e) },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, name });
}
