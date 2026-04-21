"use client";
import { useState, useTransition, useEffect, useCallback } from "react";
import type { Recommendation, Status } from "@/lib/types";
import { CoverArt } from "@/components/CoverArt";
import { EmbedPlayer } from "@/components/EmbedPlayer";
import { EditForm } from "@/components/admin/EditForm";

type Counts = { total: number; pending: number; approved: number; rejected: number };

type QueueState = {
  queued: string[];
  sent: string[];
  max: number;
};

const FILTERS: Array<{ key: Status | "all"; label: string }> = [
  { key: "pending", label: "Pool" },
  { key: "approved", label: "Published" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export function AdminClient({
  initialItems,
  initialCounts,
  initialHasMore,
}: {
  initialItems: Recommendation[];
  initialCounts: Counts;
  initialHasMore: boolean;
}) {
  const [filter, setFilter] = useState<Status | "all">("pending");
  const [items, setItems] = useState<Recommendation[]>(initialItems);
  const [counts, setCounts] = useState<Counts>(initialCounts);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [offset, setOffset] = useState(initialItems.length);
  const [isPending, startTransition] = useTransition();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueState>({ queued: [], sent: [], max: 10 });
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  const fetchPage = async (f: Status | "all", off: number) => {
    const url = `/api/pool?filter=${f}&offset=${off}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed");
    return (await res.json()) as {
      items: Recommendation[];
      total: number;
      hasMore: boolean;
      counts: Counts;
    };
  };

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/newsletter/queue", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as QueueState;
      setQueue(data);
    } catch {}
  }, []);

  // Initial queue fetch
  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Reload when filter changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchPage(filter, 0);
        if (cancelled) return;
        setItems(data.items);
        setOffset(data.items.length);
        setHasMore(data.hasMore);
        setCounts(data.counts);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const loadMore = () => {
    startTransition(async () => {
      const data = await fetchPage(filter, offset);
      setItems((prev) => [...prev, ...data.items]);
      setOffset(offset + data.items.length);
      setHasMore(data.hasMore);
      setCounts(data.counts);
    });
  };

  const updateStatus = async (id: string, status: Status) => {
    setBusyIds((s) => new Set(s).add(id));
    try {
      const res = await fetch("/api/curate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) throw new Error("Failed");
      setItems((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status } : r)),
      );
      const data = await fetchPage(filter, 0);
      setCounts(data.counts);
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const toggleQueue = async (id: string, queued: boolean) => {
    setBusyIds((s) => new Set(s).add(id));
    setSendMsg(null);
    try {
      const res = await fetch("/api/newsletter/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: queued ? "remove" : "add" }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | { ok: true; state: QueueState }
        | { error: string };
      if (!res.ok || "error" in body) {
        const err = "error" in body ? body.error : "unknown";
        setSendMsg(
          err === "full"
            ? `Queue is full (max ${queue.max}). Send or unqueue first.`
            : err === "already-sent"
              ? "That record has already been sent in a previous newsletter."
              : "Couldn't update the queue. Try again.",
        );
        return;
      }
      setQueue(body.state);
    } finally {
      setBusyIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  };

  const sendNewsletter = async () => {
    if (queue.queued.length === 0) {
      setSendMsg("Queue is empty. Tick some records to include first.");
      return;
    }
    const confirmed = window.confirm(
      `Send the weekly newsletter now with ${queue.queued.length} record${
        queue.queued.length === 1 ? "" : "s"
      }? This cannot be undone.`,
    );
    if (!confirmed) return;
    setSending(true);
    setSendMsg(null);
    try {
      const res = await fetch("/api/newsletter/send", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as
        | {
            ok: true;
            sent: true;
            subject: string;
            recordCount: number;
            ids: string[];
          }
        | { ok: true; sent: false; reason: string }
        | { error: string };
      if ("error" in body) {
        setSendMsg("Send failed: " + body.error + ". Try again.");
        return;
      }
      if (!body.sent) {
        setSendMsg(
          body.reason === "empty-queue"
            ? "Queue is empty."
            : body.reason === "no-approved-records"
              ? "None of the queued records are currently approved. Approve them first."
              : `Not sent: ${body.reason}`,
        );
        return;
      }
      setSendMsg(
        `Sent! "${body.subject}" with ${body.recordCount} record${
          body.recordCount === 1 ? "" : "s"
        }.`,
      );
      await loadQueue();
    } catch {
      setSendMsg("Couldn't reach the server. Try again.");
    } finally {
      setSending(false);
    }
  };

  const visible = items.filter((r) => filter === "all" || r.status === filter);
  const queuedSet = new Set(queue.queued);
  const sentSet = new Set(queue.sent);
  const queueFull = queue.queued.length >= queue.max;

  return (
    <div>
      <section className="border-b border-ink px-6 sm:px-8 pt-12 sm:pt-16 pb-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <h1 className="font-display font-black text-[44px] sm:text-[72px] leading-none tracking-tightest">
              Curation
              <span
                className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
                style={{ letterSpacing: "0" }}
              >
                approve releases for the public feed
              </span>
            </h1>
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex flex-col gap-1 sm:text-right">
              <div>Pool - {counts.pending}</div>
              <div>Published - {counts.approved}</div>
              <div>Rejected - {counts.rejected}</div>
              <div>Total - {counts.total}</div>
              <LogoutButton />
            </div>
          </div>

          {/* Newsletter queue panel */}
          <div className="border-t border-ink pt-4 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex flex-wrap gap-x-4 gap-y-1">
                <span className="text-ink">Weekly newsletter</span>
                <span>
                  Queued, {queue.queued.length} / {queue.max}
                </span>
                <span>Sent all-time, {queue.sent.length}</span>
              </div>
              <button
                onClick={sendNewsletter}
                disabled={sending || queue.queued.length === 0}
                className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending
                  ? "Sending…"
                  : `Send newsletter (${queue.queued.length})`}
              </button>
            </div>
            {sendMsg && (
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink">
                {sendMsg}
              </div>
            )}
          </div>

          <div className="flex gap-1 border-t border-ink pt-4">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`font-mono text-[10px] uppercase tracking-widest px-4 py-2 border ${
                  filter === f.key
                    ? "bg-ink text-paper border-ink"
                    : "border-ink hover:bg-ink hover:text-paper"
                }`}
              >
                {f.label} ({f.key === "all" ? counts.total : counts[f.key]})
              </button>
            ))}
          </div>
        </div>
      </section>

      {visible.length === 0 ? (
        <div className="px-6 sm:px-8 py-24 text-center font-mono text-[11px] uppercase tracking-widest text-mute">
          Nothing here.
        </div>
      ) : (
        <ul className="divide-y divide-ink border-b border-ink">
          {visible.map((rec, i) => {
            const isQueued = queuedSet.has(rec.id);
            const isSent = sentSet.has(rec.id);
            const canQueue = rec.status === "approved";
            // Allow "remove" even if disabled-for-add, so user can un-queue.
            const checkboxDisabled =
              busyIds.has(rec.id) ||
              !canQueue ||
              isSent ||
              (!isQueued && queueFull);
            return (
              <li key={rec.id} className="px-6 sm:px-8 py-6 flex flex-col gap-5">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-x-6 gap-y-5 items-start">
                  <div className="md:col-span-1 font-mono text-[10px] uppercase tracking-widest text-mute">
                    {String(i + 1).padStart(3, "0")}
                  </div>
                  <div className="md:col-span-2">
                    <div className="max-w-[120px]">
                      <CoverArt rec={rec} withLabels={false} />
                    </div>
                  </div>
                  <div className="md:col-span-6 flex flex-col gap-2">
                    <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex gap-3 flex-wrap items-center">
                      <span>{rec.label}</span>
                      <span>·</span>
                      <span>{rec.type === "single" ? "Single" : rec.type === "ep" ? "EP" : "Album"}</span>
                      <span>·</span>
                      <span>Released {rec.releaseDate}</span>
                      {rec.pressMentions && rec.pressMentions.length > 0 && (
                        <>
                          <span>·</span>
                          <span
                            className="border border-signal text-signal px-1.5 py-0.5"
                            title={`Covered by: ${rec.pressMentions.join(", ")}`}
                          >
                            Press: {rec.pressMentions.join(", ")}
                          </span>
                        </>
                      )}
                    </div>
                    <div
                      className="font-display font-black text-[24px] sm:text-[28px] leading-[0.95]"
                      style={{ letterSpacing: "-0.03em" }}
                    >
                      {rec.artist}
                      <span className="font-serif italic font-normal text-mute text-[0.7em] block leading-[1.1]">
                        {rec.title}
                      </span>
                    </div>
                    <p className="font-body text-[14px] leading-snug max-w-[60ch] text-ink/80">
                      {rec.description}
                      {rec.descriptionPreview && (
                        <span className="ml-2 font-mono text-[9px] uppercase tracking-widest text-mute align-middle">
                          [preview copy]
                        </span>
                      )}
                    </p>
                    <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-mute">
                      {rec.tags.map((t) => (
                        <li key={t}>, {t}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="md:col-span-3 flex flex-col gap-2 items-stretch">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
                      Status, {rec.status}
                    </span>
                    <button
                      onClick={() =>
                        setEditingId((curr) => (curr === rec.id ? null : rec.id))
                      }
                      className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-2 hover:bg-ink hover:text-paper"
                    >
                      {editingId === rec.id ? "Close editor" : "Edit fields"}
                    </button>
                    <button
                      onClick={() => updateStatus(rec.id, "approved")}
                      disabled={busyIds.has(rec.id) || rec.status === "approved"}
                      className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {rec.status === "approved" ? "Published ●" : "Publish"}
                    </button>
                    <button
                      onClick={() => updateStatus(rec.id, "rejected")}
                      disabled={busyIds.has(rec.id) || rec.status === "rejected"}
                      className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-2 hover:bg-signal hover:text-paper hover:border-signal disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {rec.status === "rejected" ? "Rejected ●" : "Reject"}
                    </button>
                    <button
                      onClick={() => updateStatus(rec.id, "pending")}
                      disabled={busyIds.has(rec.id) || rec.status === "pending"}
                      className="font-mono text-[10px] uppercase tracking-widest border border-mute text-mute px-3 py-2 hover:bg-mute hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Reset to pool
                    </button>
                    {/* Newsletter queue toggle. Only appears on approved
                        records; also greyed once this record has shipped in
                        any previous newsletter. */}
                    <label
                      className={`font-mono text-[10px] uppercase tracking-widest flex items-center gap-2 border px-3 py-2 ${
                        isQueued
                          ? "border-ink bg-ink text-paper"
                          : isSent
                            ? "border-mute text-mute cursor-not-allowed"
                            : canQueue
                              ? "border-ink hover:bg-ink hover:text-paper cursor-pointer"
                              : "border-mute text-mute cursor-not-allowed"
                      } ${checkboxDisabled && !isQueued ? "opacity-40 cursor-not-allowed" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={isQueued}
                        disabled={checkboxDisabled}
                        onChange={() => toggleQueue(rec.id, isQueued)}
                        className="accent-ink"
                      />
                      <span>
                        {isSent
                          ? "Sent in newsletter ●"
                          : isQueued
                            ? "In next newsletter ✓"
                            : !canQueue
                              ? "Newsletter (publish first)"
                              : queueFull
                                ? "Queue full"
                                : "In next newsletter"}
                      </span>
                    </label>
                  </div>

                  <div className="md:col-start-2 md:col-span-8 flex flex-col gap-2">
                    <EmbedPlayer
                      embed={rec.embed}
                      musicVideoUrl={rec.type === "single" ? rec.musicVideoUrl : null}
                      links={rec.links}
                      searchQuery={`${rec.artist} ${rec.title}`}
                    />
                    <div className="font-mono text-[10px] uppercase tracking-widest text-mute">
                      Player, {rec.embed ? rec.embed.provider : "fallback card"}
                      <span className="text-mute/60"> · change in Edit fields</span>
                    </div>
                  </div>
                </div>
                {editingId === rec.id && (
                  <EditForm
                    rec={rec}
                    onCancel={() => setEditingId(null)}
                    onSaved={(updated) => {
                      setItems((prev) =>
                        prev.map((r) => (r.id === updated.id ? updated : r)),
                      );
                      setEditingId(null);
                    }}
                    onEmbedSaved={(updated) =>
                      setItems((prev) =>
                        prev.map((r) => (r.id === updated.id ? updated : r)),
                      )
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="px-6 sm:px-8 py-12 flex justify-center">
        {hasMore ? (
          <button
            onClick={loadMore}
            disabled={isPending}
            className="font-mono text-[11px] uppercase tracking-widest border border-ink px-8 py-4 hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {isPending ? "Loading…" : "Load 15 more"}
          </button>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
            End of {filter === "all" ? "all items" : filter}.
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Logout button, tucked in the admin header next to the counts. POSTs to
 * /api/admin/logout to clear the session cookie, then reloads so the
 * middleware will bounce us back to the login page.
 */
function LogoutButton() {
  return (
    <button
      onClick={async () => {
        try {
          await fetch("/api/admin/logout", { method: "POST" });
        } finally {
          window.location.href = "/admin/login";
        }
      }}
      className="font-mono text-[9px] uppercase tracking-widest text-mute hover:text-ink border-b border-transparent hover:border-ink mt-1 self-end sm:self-end"
    >
      Sign out
    </button>
  );
}
