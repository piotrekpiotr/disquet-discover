/**
 * Send pipeline for the weekly newsletter. Manual trigger only — the admin
 * panel POSTs to /api/newsletter/send, which calls this.
 *
 * Flow:
 *   1. Load the queue state. Refuse if queue is empty.
 *   2. Load all recommendations. Resolve queued IDs, filter to approved.
 *      If every queued record has since been un-approved, refuse.
 *   3. Render HTML + text with the shared email template.
 *   4. Send via Buttondown.
 *   5. On success, move the sent IDs from queued -> sent, append history.
 *      This prevents the curator from ever re-sending the same record.
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
