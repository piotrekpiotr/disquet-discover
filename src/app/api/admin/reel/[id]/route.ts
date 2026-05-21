/**
 * GET /api/admin/reel/[id]
 *
 * Generates a 1080×1920 Instagram reel for the record `[id]` and
 * streams it back as a one-shot mp4 download. No file is persisted
 * server-side — the temp files used during composition are deleted
 * the moment ffmpeg finishes, and the response body is the raw
 * bytes of the in-memory mp4.
 *
 * Auth: admin-only (gated by middleware via `/api/admin` prefix).
 *
 * Inputs (server-side):
 *   - record from data/recommendations.json
 *   - record.coverImageUrl (downloaded for the album-art layer)
 *   - record.links.apple → iTunes Search lookup → first track's
 *     previewUrl (downloaded for the audio layer)
 *   - next animation in the cycle (counter persisted on volume)
 *
 * Output filename: `<artist-slug>-<title-slug>.mp4` via
 * Content-Disposition: attachment. The slug matches the record id
 * shape, so the curator's Downloads folder stays tidy.
 *
 * Failure modes:
 *   - missing record → 404
 *   - no Apple album link → 422 (the audio source is unrecoverable
 *     without an Apple album ID — we tell the curator instead of
 *     silently producing a silent reel)
 *   - iTunes lookup empty / preview missing → 422 ("Apple has no
 *     preview audio for this album")
 *   - ffmpeg crash → 500 with the stderr tail in the body so the
 *     curator can paste it back into a bug report
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getById } from "@/lib/data";
import { composeReel } from "@/lib/reel-composer";
import {
  pathForAnimationIndex,
  takeNextAnimationIndex,
} from "@/lib/reel-counter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = "disquet-discover/1.0 +reel";

/**
 * Extract Apple album collectionId from a music.apple.com URL.
 * Duplicated from scripts/lib/apple-url.mjs for the route to avoid
 * importing a script-side .mjs file across the Next bundle boundary
 * (scripts/* uses bare Node imports, the App Router transpiles).
 */
function extractAppleAlbumId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/album\/(?:[^/]+\/)?(\d{6,})/i);
  return m ? m[1] : null;
}

interface ITunesTrack {
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  trackNumber?: number;
  previewUrl?: string;
  collectionName?: string;
}
interface ITunesLookup {
  resultCount: number;
  results: ITunesTrack[];
}

/**
 * Ask iTunes Lookup for the album's tracks; return the FIRST track's
 * previewUrl. iTunes lookup honors `&entity=song` to include track
 * rows alongside the album row. We pick track 1 (or whichever track
 * has the lowest trackNumber and a previewUrl) so the reel features
 * a representative cut. Not every track has a preview — fall back
 * through the result list.
 */
async function fetchApplePreviewUrl(albumId: string): Promise<string | null> {
  const u = `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song`;
  const res = await fetch(u, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const j = (await res.json()) as ITunesLookup;
  const tracks = (j.results || []).filter(
    (r) => (r.wrapperType === "track" || r.kind === "song") && r.previewUrl,
  );
  if (tracks.length === 0) return null;
  tracks.sort(
    (a, b) => (a.trackNumber || 999) - (b.trackNumber || 999),
  );
  return tracks[0].previewUrl || null;
}

async function downloadTo(url: string, file: string): Promise<void> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`download failed: ${url} → HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(file, buf);
}

/**
 * mzstatic cover URLs end with `<size>x<size>bb.jpg`. Bump to
 * 1500×1500 so the 842×842 reel slot doesn't pixelate. If the URL
 * doesn't carry that suffix we send it through as-is and rely on
 * ffmpeg's scaling.
 */
function upscaleCoverUrl(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|jpeg|png)/i, "/1500x1500bb.$1");
}

function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const rec = await getById(params.id);
  if (!rec) {
    return NextResponse.json({ error: "record not found" }, { status: 404 });
  }

  const albumId = extractAppleAlbumId(rec.links?.apple);
  if (!albumId) {
    return NextResponse.json(
      {
        error:
          "No Apple Music album link on this record. Add one in the admin Edit form, then retry.",
      },
      { status: 422 },
    );
  }

  const previewUrl = await fetchApplePreviewUrl(albumId);
  if (!previewUrl) {
    return NextResponse.json(
      {
        error:
          "iTunes returned no playable preview for this album. Apple has likely region-locked the previews or the album hasn't shipped yet.",
      },
      { status: 422 },
    );
  }
  if (!rec.coverImageUrl) {
    return NextResponse.json(
      { error: "Record has no coverImageUrl — can't render album art." },
      { status: 422 },
    );
  }

  // Pick the animation BEFORE downloading anything else so a fetch
  // failure later doesn't waste an animation slot in the cycle. The
  // counter advances on read.
  const animIndex = await takeNextAnimationIndex();
  const animationPath = await pathForAnimationIndex(animIndex);

  // Temp dir per request. Deleted in `finally` regardless of outcome.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "disquet-reel-"));
  const audioPath = path.join(work, "preview.m4a");
  const coverPath = path.join(work, "cover.jpg");
  const outputPath = path.join(work, "out.mp4");

  try {
    await Promise.all([
      downloadTo(previewUrl, audioPath),
      downloadTo(upscaleCoverUrl(rec.coverImageUrl), coverPath),
    ]);

    await composeReel({
      artist: rec.artist,
      title: rec.title,
      label: rec.label,
      animationPath,
      audioPath,
      coverPath,
      outputPath,
    });

    const bytes = await fs.readFile(outputPath);
    const filename = `${slug(rec.artist)}-${slug(rec.title)}.mp4`;

    // Return the bytes inline. NextResponse with a Buffer body works
    // because Next.js wraps Node Buffers correctly for the
    // streaming runtime; for very large reels we'd switch to a
    // ReadableStream, but 1.5-3 MB per 30s output stays comfortably
    // within the inline-response budget.
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Reel-Animation-Index": String(animIndex + 1), // human-readable: 1..30
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "reel render failed", detail: msg.slice(0, 2000) },
      { status: 500 },
    );
  } finally {
    // Best-effort cleanup of the temp dir. Errors are swallowed —
    // the work dir is in /tmp anyway and the OS will reclaim it.
    fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
