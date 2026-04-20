import { getPoolPage, getCounts } from "@/lib/data";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const [page, counts] = await Promise.all([
    getPoolPage("pending", 0, 15),
    getCounts(),
  ]);

  return <AdminClient initialItems={page.items} initialCounts={counts} initialHasMore={page.hasMore} />;
}
