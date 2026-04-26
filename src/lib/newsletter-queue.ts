/**
 * Queue state for the manually-sent weekly newsletter.
 *
 * Three sets of record IDs live here:
 *
 *   - `queued`: records the curator ticked "include in next newsletter" on.
 *     Max MAX_QUEUE at any time. Clears on successful send.
 *
 *   - `sent`: every record ID that's gone out in any previous newsletter.
 *     Accumulates forever. The admin UI reads this to grey-out the
 *     checkbox so the curator can't accidentally re-queue a record that
 *     subscribers already got.
 *
 *   - `history`: one entry per successful send, with timestamp, subject, and
 *     the IDs featured. Pure audit log; not referenced anywhere in send logic.
 *
 * Storage: `data/newsletter-queue.json`. Same file-based pattern as the other
 * state stores - Railway volume persists it across deploys. When we migrate
 * to a datastore this module is the only one that changes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = path.join(process.cwd(), "data", "newsletter-queue.json");

export const MAX_QUEUE = 10;

type HistoryEntry = {
  at: string; // ISO-8601 UTC
  subject: string;
  ids: string[];
};

type State = {
  queued: string[];
  sent: string[];
  history: HistoryEntry[];
};

const EMPTY: State = { queued: [], sent: [], history: [] };

async function load(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      queued: Array.isArray(parsed.queued) ? parsed.queued.filter(isId) : [],
      sent: Array.isArray(parsed.sent) ? parsed.sent.filter(isId) : [],
      history: Array.isArray(parsed.history)
        ? parsed.history.filter(isHistoryEntry)
        : [],
    };
  } catch {
    return { queued: [], sent: [], history: [] };
  }
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length < 200;
}

function isHistoryEntry(v: unknown): v is HistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.at === "string" &&
    typeof e.subject === "string" &&
    Array.isArray(e.ids) &&
    e.ids.every(isId)
  );
}

async function save(next: State): Promise<void> {
  await fs.writeFile(
    STATE_FILE,
    JSON.stringify(next, null, 2) + "\n",
    "utf-8",
  );
}

export async function readQueueState(): Promise<State> {
  return load();
}

/**
 * Add a record to the queue. Rejects on duplicates within the SAME
 * queue, or once MAX_QUEUE is reached. A record that's gone out in a
 * previous newsletter CAN be re-queued — `sent` is now informational
 * (UI badge so the curator knows "this featured before"), not a hard
 * gate. Curators frequently want to re-feature a release weeks/months
 * later in a different mailing, and the previous "block forever after
 * one send" rule made that impossible.
 */
export async function addToQueue(
  id: string,
): Promise<
  | { ok: true; state: State }
  | { ok: false; reason: "full" | "already-queued" }
> {
  const state = await load();
  if (state.queued.includes(id)) return { ok: false, reason: "already-queued" };
  if (state.queued.length >= MAX_QUEUE) return { ok: false, reason: "full" };
  const next: State = { ...state, queued: [...state.queued, id] };
  await save(next);
  return { ok: true, state: next };
}

/** Remove a record from the queue. No-op if it wasn't queued. */
export async function removeFromQueue(id: string): Promise<State> {
  const state = await load();
  if (!state.queued.includes(id)) return state;
  const next: State = { ...state, queued: state.queued.filter((q) => q !== id) };
  await save(next);
  return next;
}

/**
 * Atomically finalise a send: move the current `queued` into `sent`, append
 * a history entry, clear `queued`. Called only on a successful broadcast.
 */
export async function commitSend(
  ids: string[],
  subject: string,
  at: Date = new Date(),
): Promise<State> {
  const state = await load();
  // Defensive: only move IDs that were actually queued. If the caller passed
  // fewer records than queued (e.g. we filtered out rejected ones at send
  // time), the rest stay queued for next time.
  const sending = new Set(ids);
  const remaining = state.queued.filter((q) => !sending.has(q));
  const newlySent = state.queued.filter((q) => sending.has(q));
  const next: State = {
    queued: remaining,
    sent: [...state.sent, ...newlySent],
    history: [
      { at: at.toISOString(), subject, ids: [...newlySent] },
      ...state.history,
    ].slice(0, 200), // cap history growth
  };
  await save(next);
  return next;
}
