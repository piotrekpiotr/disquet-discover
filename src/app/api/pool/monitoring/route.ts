import { NextRequest, NextResponse } from "next/server";
import { addExtra, getExtras, removeExtra } from "@/lib/monitoring-extras";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin endpoints for managing the curator-supplied extras to the
 * monitoring pool. Lives under /api/pool so the existing `/api/pool`
 * middleware prefix guards it.
 *
 *   GET    /api/pool/monitoring        → { artists, labels }
 *   POST   /api/pool/monitoring        body: { kind: "artist"|"label", name }
 *   DELETE /api/pool/monitoring        body: { kind: "artist"|"label", name }
 *
 * The public mirror `/api/monitoring-extras` reads the same file and is
 * the endpoint the GitHub Actions sync scripts hit each morning to merge
 * the extras with their hardcoded lists.
 */
export async function GET() {
  const extras = await getExtras();
  return NextResponse.json(extras);
}

export async function POST(req: NextRequest) {
  const body = await parseBody(req);
  if (!body) return badRequest("invalid json");
  const { kind, name } = body;
  if (kind !== "artist" && kind !== "label")
    return badRequest("kind must be 'artist' or 'label'");
  if (!name || !name.trim()) return badRequest("name is required");
  try {
    const { added, extras } = await addExtra(kind, name);
    return NextResponse.json({ added, extras });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const body = await parseBody(req);
  if (!body) return badRequest("invalid json");
  const { kind, name } = body;
  if (kind !== "artist" && kind !== "label")
    return badRequest("kind must be 'artist' or 'label'");
  if (!name) return badRequest("name is required");
  try {
    const { removed, extras } = await removeExtra(kind, name);
    return NextResponse.json({ removed, extras });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed" },
      { status: 500 },
    );
  }
}

async function parseBody(
  req: NextRequest,
): Promise<{ kind: string; name: string } | null> {
  try {
    const j = (await req.json()) as { kind?: unknown; name?: unknown };
    return {
      kind: typeof j.kind === "string" ? j.kind : "",
      name: typeof j.name === "string" ? j.name : "",
    };
  } catch {
    return null;
  }
}

function badRequest(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}
