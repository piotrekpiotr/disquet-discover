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
// Larger uploads (up to 80 MB) on slow uplinks can run past Next's
// default route timeout (10s on some adapters, indefinite locally).
// Hobby Railway allows long-running responses; the inline-Buffer
// upload path can take ~30-90s for the larger animations.
export const maxDuration = 120;

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
  // Wrap the whole handler so an upstream error (Cloudflare buffering
  // truncation, ENOSPC on the volume, OOM on the Node process) turns
  // into a meaningful JSON body instead of a generic 500 the browser
  // can't act on. Every failure path below either returns inside the
  // try (with the right status) or falls into the catch which logs +
  // returns the message string.
  try {
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
    if (file.size === 0) {
      // Catches Cloudflare / Railway partial-body truncation where the
      // multipart parses but file content is empty. Without this guard
      // we used to silently write a 0-byte stub that the GET endpoint
      // would list, fooling the curator into thinking the upload
      // succeeded.
      return NextResponse.json(
        { error: "uploaded file is empty (0 bytes) — retry the upload" },
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

    // Atomic write: stage into a `<name>.uploading` tempfile and rename
    // when fully written. A crash, OOM, or disconnect mid-write
    // leaves only the `.uploading` stub (which neither the GET listing
    // nor the cycler reads — both filter for the `NN. *.mp4` pattern,
    // so anything ending in `.uploading` is invisible to them). Rename
    // is atomic on the same filesystem, so the cycler can never read a
    // half-written file.
    const tmp = `${target}.uploading`;
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) {
      // Re-check post-parse — a Blob with non-zero `.size` can still
      // resolve to an empty buffer if the body was truncated between
      // header and content.
      return NextResponse.json(
        { error: "uploaded buffer is empty after parse — retry" },
        { status: 400 },
      );
    }
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, target);
    return NextResponse.json({ ok: true, name: cleanName, size: buf.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Log on the server so Railway logs carry the real cause. Returning
    // the message in the body too keeps the browser-side error message
    // actionable ("ENOSPC", "ENOMEM", a body truncation message, etc.)
    // instead of opaque 500.
    console.error("[reel-upload] failed:", msg);
    return NextResponse.json(
      { error: "upload failed", detail: msg.slice(0, 500) },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  // Sweep mode: ?sweep=stubs deletes every 0-byte file in the
  // animations dir (orphan stubs from previously-failed uploads).
  // Lets the curator recover from a half-finished upload session
  // with one click instead of pressing Delete on each row.
  if (req.nextUrl.searchParams.get("sweep") === "stubs") {
    let removed: string[] = [];
    try {
      const all = await fs.readdir(ANIMATIONS_PRIMARY_DIR);
      const candidates = all.filter(
        (f) => FILENAME_RE.test(f) || f.endsWith(".uploading"),
      );
      for (const name of candidates) {
        const p = path.join(ANIMATIONS_PRIMARY_DIR, name);
        try {
          const st = await fs.stat(p);
          // Sweep: 0-byte mp4 files (failed inline writes) and any
          // .uploading tempfiles (failed atomic-write stagers).
          if (st.size === 0 || name.endsWith(".uploading")) {
            await fs.unlink(p);
            removed.push(name);
          }
        } catch {
          // Ignore — file may have disappeared between readdir and stat.
        }
      }
    } catch (e) {
      return NextResponse.json(
        { error: "sweep failed", detail: String(e) },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, removed });
  }

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
