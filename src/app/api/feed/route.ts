import { NextRequest, NextResponse } from "next/server";
import { getFeedPage } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const page = await getFeedPage(cursor);
  return NextResponse.json(page);
}
