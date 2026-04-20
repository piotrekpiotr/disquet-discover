/**
 * Selection logic for the weekly newsletter. Admin manually queues records
 * via the admin panel; this module resolves the queued IDs against the
 * record store and orders them for the email body.
 *
 * There is no automatic "last 7 days" fallback anymore - if the queue is
 * empty, the send is refused. Gives the curator total control over what
 * goes out.
 */
import type { Recommendation } from "./types";

/**
 * Resolve queued IDs to records. Filters out anything that's not currently
 * approved (so a rejected or rolled-back record never lands in an email),
 * and preserves the curator's queue order - first queued, first in the email.
 */
export function selectForSend(
  all: Recommendation[],
  queuedIds: string[],
): Recommendation[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  const out: Recommendation[] = [];
  for (const id of queuedIds) {
    const hit = byId.get(id);
    if (!hit) continue;
    if (hit.status !== "approved") continue;
    out.push(hit);
  }
  return out;
}

/**
 * Subject line. No all-caps, no emojis, no "FREE" — every one of those is
 * a known spam-score signal. Just the date of send and a calm descriptor.
 */
export function subjectLine(now: Date = new Date()): string {
  const d = now.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `This week at Disquet, ${d}`;
}

/** Short intro shown under the title. Factual, no hype. */
export function introLine(recordCount: number): string {
  if (recordCount === 1) {
    return "One hand-picked release, chosen for this week.";
  }
  return `${recordCount} hand-picked releases, chosen for this week.`;
}
