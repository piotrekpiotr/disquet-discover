"use client";
import Link from "next/link";
import { useState } from "react";

interface Extras {
  artists: string[];
  labels: string[];
}

/**
 * Admin UI for curator-supplied monitoring additions. Two lists (artists
 * and labels) with add + remove. Writes go through /api/pool/monitoring;
 * the daily GitHub Actions sync scripts fetch the public mirror at
 * /api/monitoring-extras before walking iTunes / Discogs.
 *
 * What this DOESN'T do:
 *   - Edit the hardcoded ARTISTS / LABELS arrays in
 *     scripts/monitoring.mjs — those live in code and still need a PR /
 *     deploy to change. This UI only covers the additive, on-the-fly
 *     pool that gets merged at run-time.
 */
export function MonitoringClient({ initial }: { initial: Extras }) {
  const [extras, setExtras] = useState<Extras>(initial);
  const [artistInput, setArtistInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (
    kind: "artist" | "label",
    name: string,
    method: "POST" | "DELETE",
  ) => {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/pool/monitoring", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | { extras: Extras; added?: boolean; removed?: boolean }
        | { error: string };
      if (!res.ok || "error" in body) {
        setMsg("error" in body ? body.error : `HTTP ${res.status}`);
        return;
      }
      setExtras(body.extras);
      if (method === "POST") {
        setMsg(
          body.added
            ? `Added ${kind}: ${name.trim()}`
            : `Already monitoring: ${name.trim()}`,
        );
        if (kind === "artist") setArtistInput("");
        else setLabelInput("");
      } else {
        setMsg(body.removed ? `Removed ${kind}: ${name}` : `Not found: ${name}`);
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <section className="border-b border-ink px-6 sm:px-8 pt-12 sm:pt-16 pb-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <h1 className="font-display font-black text-[44px] sm:text-[72px] leading-none tracking-tightest">
              Monitoring
              <span
                className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
                style={{ letterSpacing: "0" }}
              >
                artists &amp; labels the daily sync watches
              </span>
            </h1>
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex flex-col gap-1 sm:text-right">
              <Link href="/admin" className="hover:text-ink underline">
                ← Back to curation
              </Link>
            </div>
          </div>
          <p className="font-body text-[14px] leading-snug max-w-[60ch] text-ink/80">
            Anything you add here gets merged into tomorrow&apos;s iTunes and
            Discogs sweep — no code change, no deploy. The core pool lives in
            code (<span className="font-mono text-[12px]">scripts/monitoring.mjs</span>)
            and is unchanged by this screen. Use it for tips you want to try
            before committing them to the canonical list.
          </p>
          {msg && (
            <div className="font-mono text-[10px] uppercase tracking-widest text-ink border-t border-ink pt-3">
              {msg}
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-ink border-b border-ink">
        <Column
          title="Artists"
          count={extras.artists.length}
          placeholder="e.g. Cinna Peyghamy"
          items={extras.artists}
          input={artistInput}
          setInput={setArtistInput}
          busy={busy}
          onAdd={() => submit("artist", artistInput, "POST")}
          onRemove={(name) => submit("artist", name, "DELETE")}
        />
        <Column
          title="Labels"
          count={extras.labels.length}
          placeholder="e.g. Fixed Abode"
          items={extras.labels}
          input={labelInput}
          setInput={setLabelInput}
          busy={busy}
          onAdd={() => submit("label", labelInput, "POST")}
          onRemove={(name) => submit("label", name, "DELETE")}
        />
      </section>
    </div>
  );
}

function Column({
  title,
  count,
  placeholder,
  items,
  input,
  setInput,
  busy,
  onAdd,
  onRemove,
}: {
  title: string;
  count: number;
  placeholder: string;
  items: string[];
  input: string;
  setInput: (v: string) => void;
  busy: boolean;
  onAdd: () => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="px-6 sm:px-8 py-8 flex flex-col gap-4">
      <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex items-baseline gap-3">
        <span className="text-ink">{title}</span>
        <span>{count} added</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAdd();
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
          className="flex-1 border border-ink px-3 py-2 font-mono text-[12px] bg-paper"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </form>
      {items.length === 0 ? (
        <div className="font-mono text-[10px] uppercase tracking-widest text-mute">
          No {title.toLowerCase()} added yet.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-ink/20 border-t border-ink">
          {items.map((name) => (
            <li
              key={name}
              className="flex items-center justify-between gap-4 py-2"
            >
              <span className="font-body text-[14px]">{name}</span>
              <button
                onClick={() => onRemove(name)}
                disabled={busy}
                className="font-mono text-[9px] uppercase tracking-widest text-mute hover:text-signal disabled:opacity-40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
