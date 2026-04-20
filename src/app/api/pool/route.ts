import { NextRequest, NextResponse } from "next/server";
import { getPoolPage, getCounts } from "@/lib/data";
import type { Status } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filter = (sp.get("filter") ?? "pending") as Status | "all";
  const offset = Number(sp.get("offset") ?? 0);
  const [page, counts] = await Promise.all([
    getPoolPage(filter, offset),
    getCounts(),
  ]);
  return NextResponse.json({ ...page, counts });
}
