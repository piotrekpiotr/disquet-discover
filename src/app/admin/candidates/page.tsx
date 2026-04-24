import { listCandidates } from "@/lib/media-candidates";
import { CandidatesClient } from "./CandidatesClient";

export const dynamic = "force-dynamic";

/**
 * /admin/candidates — review media-surfaced artists outside the
 * monitoring pool. Populated by the daily sync-media.mjs job which
 * scans Pitchfork / Quietus / RA / Fact for artists we don't yet
 * track. The curator promotes the interesting ones (adds them to
 * monitoring-extras, tomorrow's artist sync picks them up) or dismisses
 * the ones they've seen and passed on.
 *
 * We also surface any candidates the workflow auto-promoted on recent
 * runs (multi-source + Last.fm similarity gate passed) so the curator
 * can see — and undo — unattended additions to the pool.
 *
 * Auth: falls under the /admin/:path* middleware matcher.
 */
export default async function CandidatesPage() {
  const candidates = await listCandidates();
  // Read the full set once more with hidden included, then filter to
  // auto-promoted only for the "what did the workflow add" panel.
  const all = await listCandidates({ includeHidden: true });
  const autoPromoted = all
    .filter((r) => r.autoPromoted)
    .sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""))
    .slice(0, 30);
  return (
    <CandidatesClient initial={candidates} autoPromoted={autoPromoted} />
  );
}
