import { getExtras } from "@/lib/monitoring-extras";
import { MonitoringClient } from "./MonitoringClient";

export const dynamic = "force-dynamic";

/**
 * /admin/monitoring — manage the curator-supplied extras to the
 * monitoring pool. The hardcoded ARTISTS / LABELS arrays in
 * scripts/monitoring.mjs are unchanged; anything the curator adds here
 * is merged in at daily-sync time via /api/monitoring-extras.
 *
 * Auth: falls under the /admin/:path* middleware matcher.
 */
export default async function MonitoringPage() {
  const extras = await getExtras();
  return <MonitoringClient initial={extras} />;
}
