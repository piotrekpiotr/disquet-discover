/**
 * GET /api/admin/reel/[id]/tracks
 *
 * Returns the list of tracks on the record's Apple Music album,
 * with each track's preview availability flag — populates the
 * "Generate Reel" dropdown in /admin so the curator can pick
 * which song's 30-second preview gets embedded in the reel.
 *
 * Cheap, cacheable lookup — single iTunes call per click. The
 * upstream Lookup endpoint returns the entire album in one shot,
 * so we don't paginate.
 */
import { NextRequest, NextResponse } from "next/server";
import { getById } from "@/lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA = "disquet-discover/1.0 +reel-tracks";

function extractAppleAlbumId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/album\/(?:[^/]+\/)?(\d{6,})/i);
  return m ? m[1] : null;
}

interface ITunesEntry {
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  trackNumber?: number;
  trackId?: number;
  previewUrl?: string;
  trackTimeMillis?: number;
}
interface ITunesLookup {
  resultCount: number;
  results: ITunesEntry[];
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
      { error: "no Apple Music album link on this record" },
      { status: 422 },
    );
  }

  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    return NextResponse.json(
      { error: `iTunes lookup HTTP ${res.status}` },
      { status: 502 },
    );
  }
  const j = (await res.json()) as ITunesLookup;
  const tracks = (j.results || [])
    .filter((r) => r.wrapperType === "track" || r.kind === "song")
    .map((r) => ({
      trackNumber: r.trackNumber || 0,
      trackName: r.trackName || "",
      hasPreview: Boolean(r.previewUrl),
      durationMs: r.trackTimeMillis || 0,
    }))
    .sort((a, b) => a.trackNumber - b.trackNumber);

  return NextResponse.json({
    albumId,
    tracks,
  });
}
