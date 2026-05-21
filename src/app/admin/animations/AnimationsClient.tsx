"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface AnimEntry {
  name: string;
  size: number;
}
interface ListResponse {
  dir: string;
  files: AnimEntry[];
}
interface UploadState {
  name: string;
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const NAME_RE = /^\d{2}\.\s.+\.mp4$/i;

/**
 * Drag-drop upload UI for reel animations.
 *
 * Strategy:
 *   - Sequential uploads (one at a time) to keep the Railway service
 *     from peaking on multi-stream multipart parsing. 660 MB across
 *     30 files sequentially over a residential 50 Mbps uplink takes
 *     ~2-3 min; parallel wouldn't be much faster and would risk
 *     timeouts on slow connections.
 *   - Per-file progress visible inline; failures don't block the
 *     rest of the queue.
 *   - Filename validation client-side BEFORE upload (`NN. name.mp4`
 *     pattern) so the curator finds out about a misnamed file
 *     instantly, not after a wasted upload.
 */
export function AnimationsClient() {
  const [items, setItems] = useState<AnimEntry[]>([]);
  const [dir, setDir] = useState<string>("");
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/admin/animations", { cache: "no-store" });
      if (!r.ok) throw new Error(`list failed: ${r.status}`);
      const j = (await r.json()) as ListResponse;
      setItems(j.files);
      setDir(j.dir);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startUpload = useCallback(
    async (files: File[]) => {
      const queue: UploadState[] = files.map((f) => ({
        name: f.name,
        status: NAME_RE.test(f.name) ? "queued" : "error",
        error: NAME_RE.test(f.name)
          ? undefined
          : `Bad filename — must match "NN. slug.mp4"`,
      }));
      setUploads(queue);

      for (let i = 0; i < files.length; i++) {
        if (queue[i].status === "error") continue;
        setUploads((u) =>
          u.map((row, ix) => (ix === i ? { ...row, status: "uploading" } : row)),
        );
        try {
          const fd = new FormData();
          fd.append("file", files[i], files[i].name);
          const r = await fetch("/api/admin/animations", {
            method: "POST",
            body: fd,
          });
          if (!r.ok) {
            // Try the JSON body for `error` + `detail`; fall back to status
            // text. Either way the row's tooltip surfaces the full message
            // so the curator can decide whether to retry or escalate.
            const j = await r
              .json()
              .catch(() => ({ error: r.statusText }) as { error?: string; detail?: string });
            const msg =
              [j.error, j.detail].filter(Boolean).join(" — ") ||
              `HTTP ${r.status}`;
            throw new Error(msg);
          }
          setUploads((u) =>
            u.map((row, ix) => (ix === i ? { ...row, status: "done" } : row)),
          );
        } catch (e) {
          setUploads((u) =>
            u.map((row, ix) =>
              ix === i
                ? {
                    ...row,
                    status: "error",
                    error: e instanceof Error ? e.message : String(e),
                  }
                : row,
            ),
          );
        }
      }
      // Refresh the server list once all uploads have settled.
      refresh();
    },
    [refresh],
  );

  const onFiles = useCallback(
    (fl: FileList | null) => {
      if (!fl || fl.length === 0) return;
      startUpload(Array.from(fl));
    },
    [startUpload],
  );

  const onDelete = useCallback(
    async (name: string) => {
      if (!confirm(`Delete "${name}" from the volume? This is not undoable.`))
        return;
      const r = await fetch(
        `/api/admin/animations?name=${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Delete failed: ${j.error || r.statusText}`);
        return;
      }
      refresh();
    },
    [refresh],
  );

  const onSweepStubs = useCallback(async () => {
    const stubs = items.filter((i) => i.size === 0);
    if (stubs.length === 0) {
      alert("No 0-byte stubs to remove.");
      return;
    }
    if (
      !confirm(
        `Remove ${stubs.length} empty (0-byte) file(s) from the volume? They're leftovers from failed uploads; you'll be able to re-upload them after.`,
      )
    )
      return;
    const r = await fetch(`/api/admin/animations?sweep=stubs`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Sweep failed: ${j.error || r.statusText}`);
      return;
    }
    refresh();
  }, [items, refresh]);

  const stubCount = items.filter((i) => i.size === 0).length;

  const totalSize = items.reduce((acc, it) => acc + it.size, 0);

  return (
    <main className="px-6 sm:px-10 py-10 max-w-4xl mx-auto">
      <h1 className="font-display text-[40px] leading-none tracking-tightest mb-2">
        Animations
      </h1>
      <p className="font-mono text-[11px] uppercase tracking-widest text-mute mb-6">
        Backgrounds for the Generate Reel feature. Upload all 30, the
        cycler walks through them in filename order.
      </p>

      {/* DROP TARGET. A plain <label> wrapping a hidden <input
          type=file multiple> is the most accessible drag-drop UI:
          screen readers see a labelled control, click-to-pick works
          on iOS Safari (no JS for the picker), and the styled inner
          div handles drag visual feedback. */}
      <label
        htmlFor="animation-upload"
        className="block border border-dashed border-ink rounded-none px-6 py-12 text-center cursor-pointer hover:bg-ink/5"
        onDragOver={(e) => {
          e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          onFiles(e.dataTransfer.files);
        }}
      >
        <div className="font-mono text-[12px] uppercase tracking-widest">
          Drop mp4 files here, or click to browse
        </div>
        <div className="font-body text-[13px] text-ink/70 mt-2">
          Filenames must look like <code>01. grid-breathe.mp4</code>.
          Max 80 MB per file. Drag all 30 at once — uploads run one
          at a time.
        </div>
        <input
          id="animation-upload"
          ref={inputRef}
          type="file"
          accept="video/mp4"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </label>

      {uploads.length > 0 && (
        <div className="mt-6 border border-ink/30 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-mute mb-2">
            Upload queue
          </div>
          <ul className="space-y-1">
            {uploads.map((u, i) => (
              <li
                key={i}
                className="font-mono text-[12px] flex justify-between gap-3"
              >
                <span className="truncate">{u.name}</span>
                <span
                  className={
                    u.status === "done"
                      ? "text-ink/70"
                      : u.status === "error"
                        ? "text-signal"
                        : u.status === "uploading"
                          ? "text-ink"
                          : "text-mute"
                  }
                >
                  {u.status === "done"
                    ? "✓ uploaded"
                    : u.status === "uploading"
                      ? "uploading…"
                      : u.status === "error"
                        ? `✗ ${u.error}`
                        : "queued"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-10">
        <div className="flex justify-between items-baseline mb-3 gap-3">
          <h2 className="font-mono text-[12px] uppercase tracking-widest">
            On server ({items.length} / 30)
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-widest text-mute truncate">
            {dir || "—"} · {humanSize(totalSize)}
          </span>
        </div>
        {/* Sweep stubs prompt — visible only if there are 0-byte rows.
            A previously-failed upload session leaves entries in the
            listing with size 0 (the inline-write path used to write
            a stub on truncation; the atomic-write path doesn't, but
            we may still inherit stubs from older deploys). One click
            removes them all so the curator can re-upload. */}
        {stubCount > 0 && (
          <div className="mb-3 border border-signal text-signal px-3 py-2 flex items-center justify-between gap-3">
            <span className="font-mono text-[11px]">
              {stubCount} empty 0-byte file{stubCount === 1 ? "" : "s"} from
              a failed upload run — these aren&apos;t usable. Clear them
              and re-upload.
            </span>
            <button
              type="button"
              onClick={onSweepStubs}
              className="font-mono text-[10px] uppercase tracking-widest border border-signal px-3 py-1 hover:bg-signal hover:text-paper shrink-0"
            >
              Clear {stubCount} stub{stubCount === 1 ? "" : "s"}
            </button>
          </div>
        )}
        {refreshing && items.length === 0 ? (
          <div className="font-mono text-[11px] text-mute">Loading…</div>
        ) : items.length === 0 ? (
          <div className="font-mono text-[11px] text-mute">
            No animations uploaded yet. Drop files in the box above.
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((it) => {
              const isStub = it.size === 0;
              return (
                <li
                  key={it.name}
                  className={`flex justify-between items-center gap-3 border-b border-ink/10 py-1.5 ${
                    isStub ? "bg-signal/10" : ""
                  }`}
                >
                  <span
                    className={`font-mono text-[13px] truncate ${isStub ? "text-signal" : ""}`}
                  >
                    {it.name}
                    {isStub && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-widest">
                        (empty — failed)
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
                    {humanSize(it.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onDelete(it.name)}
                    className="font-mono text-[10px] uppercase tracking-widest border border-ink px-2 py-1 hover:bg-signal hover:text-paper hover:border-signal"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
