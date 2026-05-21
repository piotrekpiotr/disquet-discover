"use client";

import { useCallback, useState } from "react";

/**
 * Generate-Reel button with a lazy-loaded track picker.
 *
 * Two-step interaction:
 *   1. Curator clicks the button → component fetches the album's
 *      track list from /api/admin/reel/[id]/tracks (one iTunes
 *      Lookup hop). The button stays disabled while the request
 *      is in flight; the inline track list expands below it on
 *      success.
 *   2. Curator picks a track from the list → navigates to
 *      /api/admin/reel/[id]?track=N in a new tab. The browser's
 *      built-in download UI handles the result; reel render
 *      typically takes 8–20s during which the new tab shows the
 *      spinner.
 *
 * Edge cases handled:
 *   - Single-track records (singles) auto-select that track without
 *     showing the picker.
 *   - Tracks with no `previewUrl` (region locks) are listed but
 *     disabled, with a small "no preview" annotation so the curator
 *     can see why their first-choice cut isn't selectable.
 *   - Network failure / 422 from the tracks endpoint surfaces inline
 *     beneath the button instead of via alert().
 */
export function ReelButton({ recordId }: { recordId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; tracks: TrackEntry[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const openPicker = useCallback(async () => {
    if (state.kind === "loading" || state.kind === "ready") return;
    setState({ kind: "loading" });
    try {
      const r = await fetch(`/api/admin/reel/${recordId}/tracks`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as { tracks: TrackEntry[] };
      const tracks = j.tracks || [];
      // Single playable track: skip the picker, go straight to download.
      const playable = tracks.filter((t) => t.hasPreview);
      if (playable.length === 1) {
        triggerDownload(recordId, playable[0].trackNumber);
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "ready", tracks });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [recordId, state.kind]);

  const close = useCallback(() => setState({ kind: "idle" }), []);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={
          state.kind === "ready" || state.kind === "error" ? close : openPicker
        }
        disabled={state.kind === "loading"}
        className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 text-center"
      >
        {state.kind === "loading"
          ? "Loading tracks…"
          : state.kind === "ready"
            ? "Hide tracks"
            : state.kind === "error"
              ? "Try again"
              : "Generate Reel ↓"}
      </button>

      {state.kind === "error" && (
        <div className="font-mono text-[10px] text-signal px-2 py-1">
          {state.message}
        </div>
      )}

      {state.kind === "ready" && (
        <ul className="border border-ink/30 max-h-64 overflow-y-auto">
          {state.tracks.length === 0 ? (
            <li className="font-mono text-[10px] text-mute px-3 py-2">
              No tracks returned by Apple
            </li>
          ) : (
            state.tracks.map((t) => (
              <li
                key={t.trackNumber}
                className="border-b border-ink/10 last:border-b-0"
              >
                <button
                  type="button"
                  disabled={!t.hasPreview}
                  onClick={() => {
                    triggerDownload(recordId, t.trackNumber);
                    close();
                  }}
                  className="w-full text-left font-mono text-[11px] px-3 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink flex justify-between gap-3"
                  title={
                    t.hasPreview
                      ? "Generate reel from this track's 30-sec preview"
                      : "Apple has no preview for this track"
                  }
                >
                  <span className="truncate">
                    {String(t.trackNumber).padStart(2, "0")}. {t.trackName}
                  </span>
                  <span className="text-mute shrink-0">
                    {t.hasPreview ? "↓" : "no preview"}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

interface TrackEntry {
  trackNumber: number;
  trackName: string;
  hasPreview: boolean;
  durationMs: number;
}

/**
 * Trigger the actual reel render + download in a new tab. The
 * window.open call must happen during the same synchronous click
 * handler that produced the user gesture — otherwise iOS Safari and
 * some popup-blockers reject it. We use noopener for security and
 * "_blank" to avoid replacing the admin tab on failure (a 500
 * response renders inline in the new tab where the curator can
 * read the error without losing their place).
 */
function triggerDownload(recordId: string, trackNumber: number): void {
  const url = `/api/admin/reel/${encodeURIComponent(recordId)}?track=${trackNumber}`;
  window.open(url, "_blank", "noopener");
}
