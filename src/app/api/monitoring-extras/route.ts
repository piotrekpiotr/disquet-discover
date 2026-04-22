import { NextResponse } from "next/server";
import { getExtras } from "@/lib/monitoring-extras";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/monitoring-extras
 *
 * Public, read-only mirror of the curator-supplied additions to the
 * monitoring pool. Returns `{ artists: [...], labels: [...] }`.
 *
 * Primary caller: the daily GitHub Actions sync workflow. It fetches this
 * before walking iTunes / Discogs and unions the result with its
 * hardcoded ARTISTS / LABELS lists. Keeping this endpoint unauthenticated
 * avoids having to ship a GitHub-side secret; the payload is neither
 * sensitive nor privileged — it's just "which artists and labels does
 * the curator want monitored today".
 *
 * Writes live at /api/pool/monitoring (admin only). See
 * src/lib/monitoring-extras.ts for the shared store.
 */
export async function GET() {
  const extras = await getExtras();
  // 5-minute cache header nudges the GH runner (and anyone else scraping)
  // to not hammer us, but force-dynamic means Next won't cache the
  // response itself — we read the file on every hit so edits reflect
  // immediately in the admin UI's GET calls.
  return NextResponse.json(extras, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=60" },
  });
}
