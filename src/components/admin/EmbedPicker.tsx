"use client";
import { useState } from "react";
import type { Embed, EmbedProvider, Recommendation } from "@/lib/types";

/**
 * Admin-only UI for choosing which player shows on the public feed card.
 *
 * Three interactions:
 *   1. Provider radio + src/height fields - explicit "build an embed from
 *      scratch" form for when the curator wants total control.
 *   2. Paste an <iframe ...> blob from any streaming site - the form
 *      parses out src + height automatically. Bandcamp's own "Share / Embed"
 *      dialog gives you this exact HTML, so copy-paste from there just works.
 *   3. Clear - wipes the embed so the public card falls back to the
 *      FallbackCard with streaming-service search links.
 *
 * The patch is sent to /api/edit which already accepts `embed` and merges
 * it into the record.
 *
 * Provider detection: if the curator pastes a raw URL we try to match the
 * host against known providers; on failure we leave the provider as-is so
 * the curator can pick from the radio group manually.
 */

const PROVIDERS: Array<{ key: EmbedProvider; label: string }> = [
  { key: "bandcamp", label: "Bandcamp" },
  { key: "apple", label: "Apple Music" },
  { key: "spotify", label: "Spotify" },
  { key: "deezer", label: "Deezer" },
  { key: "soundcloud", label: "SoundCloud" },
  { key: "youtube", label: "YouTube" },
];

/** Guess provider from a src URL. Falls back to null when no host matches. */
function detectProvider(src: string): EmbedProvider | null {
  try {
    const h = new URL(src).hostname;
    if (h.includes("bandcamp.com")) return "bandcamp";
    if (h.includes("music.apple.com")) return "apple";
    if (h.includes("spotify.com")) return "spotify";
    if (h.includes("deezer.com")) return "deezer";
    if (h.includes("soundcloud.com")) return "soundcloud";
    if (h.includes("youtube.com") || h.includes("youtube-nocookie.com"))
      return "youtube";
  } catch {
    /* not a URL */
  }
  return null;
}

/** Parse an <iframe ... src=... height=...> blob. Returns fields if found. */
function parseIframeBlob(blob: string): { src?: string; height?: number } {
  // Accept either a literal <iframe> tag or just a URL on its own line.
  const trimmed = blob.trim();
  if (!trimmed) return {};
  // Plain URL case.
  if (/^https?:\/\//i.test(trimmed) && !trimmed.includes("<")) {
    return { src: trimmed };
  }
  const srcMatch = trimmed.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
  const heightMatch = trimmed.match(/\bheight\s*=\s*["']?(\d{2,4})["']?/i);
  return {
    src: srcMatch?.[1],
    height: heightMatch ? Number(heightMatch[1]) : undefined,
  };
}

export function EmbedPicker({
  rec,
  onSaved,
}: {
  rec: Recommendation;
  onSaved: (updated: Recommendation) => void;
}) {
  const current = rec.embed || null;
  const [provider, setProvider] = useState<EmbedProvider>(
    current?.provider || "bandcamp",
  );
  const [src, setSrc] = useState(current?.src || "");
  const [height, setHeight] = useState<string>(
    current?.height ? String(current.height) : "",
  );
  const [blob, setBlob] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  /** Populate the form from a pasted iframe / URL blob. */
  const applyBlob = () => {
    const parsed = parseIframeBlob(blob);
    if (!parsed.src) {
      setErr("Couldn't find an iframe src in that blob.");
      return;
    }
    setErr(null);
    setSrc(parsed.src);
    if (parsed.height) setHeight(String(parsed.height));
    const detected = detectProvider(parsed.src);
    if (detected) setProvider(detected);
  };

  const save = async (newEmbed: Embed | null) => {
    setSaving(true);
    setErr(null);
    setOk(false);
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: rec.id, patch: { embed: newEmbed } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as Recommendation;
      onSaved(updated);
      setOk(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const onApply = () => {
    if (!src.trim()) {
      setErr("Set a player URL before saving.");
      return;
    }
    const h = Number(height);
    const embed: Embed = {
      provider,
      src: src.trim(),
      ...(Number.isFinite(h) && h > 0 ? { height: h } : {}),
    };
    void save(embed);
  };

  const onClear = () => void save(null);

  return (
    <div className="flex flex-col gap-4 border border-ink/30 p-4 bg-paper-2/30">
      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
        <span className="text-ink">Player</span>
        <span className="text-mute">
          {current
            ? `current: ${current.provider}`
            : "no player set - fallback card shown"}
        </span>
      </div>

      {/* Paste-from-streaming-site shortcut. */}
      <div className="flex flex-col gap-2">
        <label className="font-mono text-[9px] uppercase tracking-widest text-mute">
          Paste iframe HTML or URL (from Bandcamp Share / Embed, Spotify
          embed code, etc.)
        </label>
        <textarea
          value={blob}
          onChange={(e) => setBlob(e.target.value)}
          rows={3}
          className="border border-ink bg-paper px-2 py-1 font-mono text-[11px] focus:outline-none focus:bg-paper-2/40"
          placeholder='<iframe style="border: 0; width: 350px; height: 470px;" src="https://bandcamp.com/EmbeddedPlayer/album=..." ...></iframe>'
        />
        <button
          type="button"
          onClick={applyBlob}
          className="font-mono text-[10px] uppercase tracking-widest border border-ink px-3 py-1.5 hover:bg-ink hover:text-paper w-fit"
        >
          Parse paste
        </button>
      </div>

      {/* Explicit fields. */}
      <div className="flex flex-col gap-2">
        <label className="font-mono text-[9px] uppercase tracking-widest text-mute">
          Provider
        </label>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <label
              key={p.key}
              className={`font-mono text-[10px] uppercase tracking-widest border px-3 py-1.5 cursor-pointer ${
                provider === p.key
                  ? "border-ink bg-ink text-paper"
                  : "border-ink hover:bg-ink hover:text-paper"
              }`}
            >
              <input
                type="radio"
                name={`prov-${rec.id}`}
                value={p.key}
                checked={provider === p.key}
                onChange={() => setProvider(p.key)}
                className="hidden"
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label className="font-mono text-[9px] uppercase tracking-widest text-mute">
          Iframe src URL
        </label>
        <input
          type="url"
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          className="border border-ink bg-paper px-2 py-1 font-mono text-[11px] focus:outline-none focus:bg-paper-2/40"
          placeholder="https://bandcamp.com/EmbeddedPlayer/album=1234/..."
        />
      </div>

      <div className="flex flex-col gap-2 max-w-[160px]">
        <label className="font-mono text-[9px] uppercase tracking-widest text-mute">
          Height (px, optional)
        </label>
        <input
          type="number"
          inputMode="numeric"
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          className="border border-ink bg-paper px-2 py-1 font-mono text-[11px] focus:outline-none focus:bg-paper-2/40"
          placeholder="450"
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onApply}
          disabled={saving}
          className="font-mono text-[10px] uppercase tracking-widest border border-ink bg-ink text-paper px-4 py-2 hover:bg-paper hover:text-ink disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save player"}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={saving || !current}
          className="font-mono text-[10px] uppercase tracking-widest border border-mute text-mute px-4 py-2 hover:bg-mute hover:text-paper disabled:opacity-40"
        >
          Clear player
        </button>
        {ok && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-mute">
            saved
          </span>
        )}
        {err && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-signal">
            {err}
          </span>
        )}
      </div>
    </div>
  );
}
