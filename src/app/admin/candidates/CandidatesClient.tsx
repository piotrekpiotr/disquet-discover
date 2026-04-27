"use client";
import Link from "next/link";
import { useState } from "react";
import type { CandidateRow } from "@/lib/media-candidates";

/**
 * Admin UI for reviewing media-driven candidate artists — names that
 * Pitchfork / Quietus / RA / Fact have written about but which aren't in
 * our monitoring pool yet. Two buttons per row:
 *
 *   Promote → adds the artist to monitoring-extras (goes into tomorrow's
 *             sync-artists run), hides the candidate.
 *   Dismiss → hides the candidate without promoting.
 *
 * Hidden candidates are kept on disk (not deleted) so the RSS scan
 * doesn't surface them again.
 */
const SOURCE_LABEL: Record<string, string> = {
  pitchfork: "Pitchfork",
  quietus: "Quietus",
  ra: "Resident Advisor",
  fact: "Fact",
};

export function CandidatesClient({
  initial,
  autoPromoted = [],
}: {
  initial: CandidateRow[];
  autoPromoted?: CandidateRow[];
}) {
  const [rows, setRows] = useState<CandidateRow[]>(initial);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (name: string, action: "promote" | "dismiss") => {
    setBusyName(name);
    setMsg(null);
    try {
      const res = await fetch("/api/pool/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, action }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | { ok: true }
        | { error: string };
      if (!res.ok || "error" in body) {
        setMsg("error" in body ? body.error : `HTTP ${res.status}`);
        return;
      }
      setRows((prev) => prev.filter((r) => r.name !== name));
      setMsg(
        action === "promote"
          ? `Promoted ${name} — tomorrow's sync will include them.`
          : `Dismissed ${name}.`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "network error");
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div>
      <section className="border-b border-ink px-6 sm:px-8 pt-12 sm:pt-16 pb-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <h1 className="font-display font-black text-[44px] sm:text-[72px] leading-none tracking-tightest">
              Candidates
              <span
                className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
                style={{ letterSpacing: "0" }}
              >
                artists the press is writing about, not yet in the pool
              </span>
            </h1>
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex flex-col gap-1 sm:text-right">
              <Link href="/admin" className="hover:text-ink underline">
                ← Back to curation
              </Link>
              <Link
                href="/admin/monitoring"
                className="hover:text-ink underline"
              >
                Monitoring →
              </Link>
            </div>
          </div>
          <p className="font-body text-[14px] leading-snug max-w-[70ch] text-ink/80">
            Each morning the daily sync scans Pitchfork, The Quietus,
            Resident Advisor and Fact. Artists mentioned by those outlets
            who aren&apos;t already in your pool land here. Promote the
            interesting ones to <span className="font-mono text-[12px]">monitoring-extras</span>{" "}
            (tomorrow&apos;s artist sweep picks them up), dismiss the rest.
            Multi-source candidates (≥2 outlets covering the same artist)
            are sorted to the top because they&apos;re the strongest
            signal.
          </p>
          {msg && (
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink border-t border-ink pt-3">
              {msg}
            </div>
          )}
        </div>
      </section>

      {autoPromoted.length > 0 && (
        <section className="border-b border-ink px-6 sm:px-8 py-8">
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <h2 className="font-display font-black text-[22px] tracking-tight">
                Auto-promoted by the workflow
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
                {autoPromoted.length} recent
              </span>
            </div>
            <p className="font-body text-[13px] leading-snug max-w-[70ch] text-ink/70">
              These artists cleared both gates in a recent run — two or more
              outlets covering them <em>and</em> a Last.fm similarity link to
              someone already in the pool — so sync-media added them to
              monitoring-extras without waiting for review. Check the {" "}
              <Link href="/admin/monitoring" className="underline">
                monitoring list
              </Link>{" "}
              to remove any the workflow got wrong.
            </p>
            <ul className="flex flex-col divide-y divide-ink/20 border-t border-ink">
              {autoPromoted.map((row) => (
                <li key={row.name} className="flex flex-col gap-1 py-3">
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="font-body text-[16px]">{row.name}</span>
                    <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
                      {row.autoPromoteScore?.bestPoolArtist
                        ? `≈ ${row.autoPromoteScore.bestPoolArtist} @ ${row.autoPromoteScore.topMatch.toFixed(2)}`
                        : row.autoPromoteScore
                          ? `${row.autoPromoteScore.poolMatchCount} pool matches`
                          : ""}
                    </span>
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex items-baseline gap-3 flex-wrap">
                    <span>
                      {(row.sources || [])
                        .map((s) => SOURCE_LABEL[s] || s)
                        .join(" · ") || "—"}
                    </span>
                    <span>last seen {row.lastSeen || "?"}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="border-b border-ink px-6 sm:px-8 py-8">
        {rows.length === 0 ? (
          <div className="font-mono text-[10px] uppercase tracking-widest text-mute">
            No candidates awaiting review. (The daily media scan will add
            more tomorrow — or they may be dismissed / already promoted.)
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-ink/20 border-t border-ink">
            {rows.map((row) => (
              <li
                key={row.name}
                className="flex items-start justify-between gap-4 py-4 flex-wrap"
              >
                <div className="flex flex-col gap-1 flex-1 min-w-0">
                  <div className="font-body text-[18px] leading-snug">
                    {row.name}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex items-baseline gap-3 flex-wrap">
                    <span>
                      {(row.sources || [])
                        .map((s) => SOURCE_LABEL[s] || s)
                        .join(" · ") || "—"}
                    </span>
                    <span>{row.mentions} mention(s)</span>
                    <span>last seen {row.lastSeen || "?"}</span>
                  </div>
                  {row.titleHints?.length > 0 && (
                    <div className="font-body text-[13px] text-ink/70 leading-snug">
                      re:{" "}
                      {row.titleHints.slice(0, 3).map((t, i) => (
                        <span key={t}>
                          <span className="italic">{t}</span>
                          {i < Math.min(2, row.titleHints.length - 1)
                            ? ", "
                            : ""}
                        </span>
                      ))}
                      {row.titleHints.length > 3 && ", …"}
                    </div>
                  )}
                  {row.poolTags && row.poolTags.length > 0 && (
                    // Surfaced when sync-media's Last.fm tag-discovery
                    // step matched this artist on N of the pool's
                    // genre-fingerprint tags. Curator can read at-a-
                    // glance "yes that's our scene" without leaving
                    // the page.
                    <div className="font-mono text-[10px] uppercase tracking-widest text-mute leading-snug">
                      matched on {row.poolTagOverlap || row.poolTags.length} pool tag
                      {(row.poolTagOverlap || row.poolTags.length) === 1 ? "" : "s"}
                      :{" "}
                      <span className="text-ink">
                        {row.poolTags.slice(0, 6).join(" · ")}
                        {row.poolTags.length > 6 ? " · …" : ""}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => act(row.name, "promote")}
                    disabled={busyName === row.name}
                    className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Promote
                  </button>
                  <button
                    onClick={() => act(row.name, "dismiss")}
                    disabled={busyName === row.name}
                    className="font-mono text-[10px] uppercase tracking-widest text-mute hover:text-signal disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
