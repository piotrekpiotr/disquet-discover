import { NextRequest, NextResponse } from "next/server";
import { getPoolPage, getCounts } from "@/lib/data";
import type { Status } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filter = (sp.get("filter") ?? "pending") as Status | "all";
  const offset = Number(sp.get("offset") ?? 0);
  // Optional case-insensitive search. Matched server-side across the
  // full pool (artist + title + label) so the curator can find a
  // specific record even when it lives on a different tab. Empty / un-
  // set means "no filter" — the existing pagination shape is preserved.
  const q = sp.get("q") ?? "";
  const [page, counts] = await Promise.all([
    getPoolPage(filter, offset, undefined, q),
    getCounts(q),
  ]);
  return NextResponse.json({ ...page, counts });
}
