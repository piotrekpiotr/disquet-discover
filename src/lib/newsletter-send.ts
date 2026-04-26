/**
 * Draft-creation pipeline for the newsletter. Triggered manually from the
 * admin panel's "Create draft" button.
 *
 * Flow:
 *   1. Load the queue state. Refuse if queue is empty.
 *   2. Load all recommendations. Resolve queued IDs, filter to approved.
 *      If every queued record has since been un-approved, refuse.
 *   3. Render HTML + text with the shared email template.
 *   4. POST to Buttondown — this creates a DRAFT, not an actual send.
 *      The curator opens the draft in Buttondown's web UI to preview /
 *      tweak / publish. See sendBroadcast() in newsletter.ts.
 *   5. On success, clear the queue and append a history entry. We
 *      DON'T block re-queueing the same record into a future newsletter —
 *      the `sent` accumulator is informational only (chip badge in admin
 *      shows "sent N× before"); the curator can re-feature anything.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Recommendation } from "@/lib/types";
import { renderHtml, renderText } from "@/lib/email-template";
import { sendBroadcast } from "@/lib/newsletter";
import {
  introLine,
  selectForSend,
  subjectLine,
} from "@/lib/newsletter-payload";
import { commitSend, readQueueState } from "@/lib/newsletter-queue";

export type SendResult =
  | {
      ok: true;
      sent: true;
      subject: string;
      recordCount: number;
      ids: string[];
    }
  | { ok: true; sent: false; reason: "empty-queue" | "no-approved-records" };

async function loadAllRecords(): Promise<Recommendation[]> {
  const file = path.join(process.cwd(), "data", "recommendations.json");
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw) as Recommendation[];
}

/**
 * Render + send the current queued records. On success, commit the send so
 * the same records can't go out again.
 */
export async function sendQueuedNewsletter(): Promise<SendResult> {
  const state = await readQueueState();
  if (state.queued.length === 0) {
    return { ok: true, sent: false, reason: "empty-queue" };
  }

  const all = await loadAllRecords();
  const records = selectForSend(all, state.queued);
  if (records.length === 0) {
    return { ok: true, sent: false, reason: "no-approved-records" };
  }

  const subject = subjectLine();
  const intro = introLine(records.length);
  const html = renderHtml({ title: subject, intro, records });
  const text = renderText({ title: subject, intro, records });

  await sendBroadcast({ subject, html, text });

  const sentIds = records.map((r) => r.id);
  await commitSend(sentIds, subject);

  return {
    ok: true,
    sent: true,
    subject,
    recordCount: records.length,
    ids: sentIds,
  };
}
