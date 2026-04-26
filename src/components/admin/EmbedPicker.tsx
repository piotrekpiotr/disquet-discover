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
    if (
      h.includes("youtube.com") ||
      h.includes("youtube-nocookie.com") ||
      h === "youtu.be"
    )
      return "youtube";
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * YouTube is unforgiving about the iframe `src` URL — only the
 * `youtube.com/embed/<id>` form actually loads inside an iframe. The
 * `watch?v=<id>` URL refuses to embed (responds with `X-Frame-Options:
 * SAMEORIGIN`), and `youtu.be/<id>` is a redirect, not an embeddable
 * page. Convert both to the embed form so the curator can paste any
 * YouTube URL they have to hand without thinking about which one is
 * the iframe-friendly one. Iframes (already embed URLs) and unknown
 * shapes pass through untouched.
 */
function normalizeYouTubeSrc(src: string): string {
  try {
    const u = new URL(src);
    // Already an embed URL — preserve the query string (si=, t=, etc).
    if (
      (u.hostname.includes("youtube.com") ||
        u.hostname.includes("youtube-nocookie.com")) &&
      /^\/embed\//.test(u.pathname)
    ) {
      return src;
    }
    // youtu.be/<id>?<params> → youtube.com/embed/<id>?<params>
    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").split("/")[0];
      if (!id) return src;
      const qs = u.search ? u.search : "";
      return `https://www.youtube.com/embed/${id}${qs}`;
    }
    // youtube.com/watch?v=<id>&t=… → youtube.com/embed/<id>?t=…
    if (
      u.hostname.includes("youtube.com") &&
      u.pathname === "/watch" &&
      u.searchParams.has("v")
    ) {
      const id = u.searchParams.get("v");
      if (!id) return src;
      const params = new URLSearchParams(u.searchParams);
      params.delete("v");
      const qs = params.toString();
      return `https://www.youtube.com/embed/${id}${qs ? `?${qs}` : ""}`;
    }
  } catch {
    /* not a URL — leave alone */
  }
  return src;
}

/**
 * Parse an `<iframe ...>` blob. Returns src, height, and width if found.
 *
 * Height can arrive three ways depending on the source:
 *   - `height="654"`       — Spotify / Apple Music / YouTube all ship this.
 *   - `style="height: 654px"` — Bandcamp's "Share / Embed" dialog uses this
 *     (and only this — there's no height attribute). Missing it silently
 *     made Bandcamp's tall large-player render at the default 450px and
 *     clip the tracklist, which is what the curator hit.
 *   - missing          — we return undefined and the card falls back to its
 *                        default height. Better than guessing.
 *
 * Width is parsed on the same principle; we don't use it yet (the card is
 * fluid 100%), but returning it lets the save logic persist a hint for
 * future responsive work.
 */
function parseIframeBlob(blob: string): {
  src?: string;
  height?: number;
  width?: number;
} {
  // Accept either a literal <iframe> tag or just a URL on its own line.
  const trimmed = blob.trim();
  if (!trimmed) return {};
  // Plain URL case.
  if (/^https?:\/\//i.test(trimmed) && !trimmed.includes("<")) {
    return { src: trimmed };
  }

  const srcMatch = trimmed.match(/\bsrc\s*=\s*["']([^"']+)["']/i);

  // Attribute form: height="123" / height='123' / height=123
  const heightAttr = trimmed.match(/\bheight\s*=\s*["']?(\d{2,4})["']?/i);
  const widthAttr = trimmed.match(/\bwidth\s*=\s*["']?(\d{2,4})["']?/i);

  // Style form inside style="...". We only look inside the style attribute
  // so we don't accidentally pick up a height: value elsewhere in the blob.
  const styleBlock = trimmed.match(/\bstyle\s*=\s*["']([^"']+)["']/i)?.[1] || "";
  const heightStyle = styleBlock.match(/(?:^|[;\s])height\s*:\s*(\d{2,4})\s*px\b/i);
  const widthStyle = styleBlock.match(/(?:^|[;\s])width\s*:\s*(\d{2,4})\s*px\b/i);

  const heightRaw = heightAttr?.[1] || heightStyle?.[1];
  const widthRaw = widthAttr?.[1] || widthStyle?.[1];

  return {
    src: srcMatch?.[1],
    height: heightRaw ? Number(heightRaw) : undefined,
    width: widthRaw ? Number(widthRaw) : undefined,
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
  // Width is optional and mostly matters for Bandcamp's big-artwork Standard
  // player (350px), which otherwise stretches uncontrollably inside the
  // card. For every other provider leaving this blank is the right default —
  // EmbedPlayer only applies a fixed width when this is set.
  const [width, setWidth] = useState<string>(
    current?.width ? String(current.width) : "",
  );
  const [blob, setBlob] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  /**
   * Populate the form from an iframe / URL blob. Called both by the
   * explicit "Parse paste" button (with quiet=false — show an error if
   * no src was found) and automatically on paste (quiet=true — don't
   * shout an error when someone's still typing).
   */
  const applyBlobFrom = (text: string, quiet: boolean) => {
    const parsed = parseIframeBlob(text);
    if (!parsed.src) {
      if (!quiet) setErr("Couldn't find an iframe src in that blob.");
      return;
    }
    setErr(null);
    // Normalise YouTube watch / youtu.be URLs into the embed form
    // YouTube actually permits in iframes. No-op for other providers
    // and for already-correct embed URLs.
    const normalisedSrc = normalizeYouTubeSrc(parsed.src);
    setSrc(normalisedSrc);
    // Height is what makes Bandcamp's tall player (654px) render correctly
    // without the curator touching the number field. If the iframe has no
    // height we leave the existing value alone — saving without a height
    // means EmbedPlayer uses its default 450 which is right for Apple /
    // Spotify / Deezer.
    if (parsed.height) setHeight(String(parsed.height));
    // Width is also picked up from the paste. Bandcamp's Big-artwork
    // Standard player ships as `width: 350px` and MUST be kept at that
    // width or the cover art stretches the whole card. For other
    // providers (Apple, Spotify, Deezer) width is usually absent from
    // the blob or explicitly fluid, so we only overwrite when the parse
    // yielded a real number.
    if (parsed.width) setWidth(String(parsed.width));
    const detected = detectProvider(normalisedSrc);
    if (detected) setProvider(detected);
  };

  const applyBlob = () => applyBlobFrom(blob, /*quiet=*/ false);

  /**
   * Auto-parse as soon as a blob is pasted — the curator shouldn't have
   * to paste, then click "Parse paste", then click Save. We read the
   * clipboard payload directly (rather than waiting for React's
   * controlled-input round-trip) so src + height + provider all land in
   * one step, which is what "adapt to the pasted embed code" should feel
   * like.
   */
  const onBlobPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    // Let the textarea show the paste in the normal flow; apply on the
    // next tick so `blob` state is also up to date.
    setTimeout(() => applyBlobFrom(text, /*quiet=*/ true), 0);
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
    const w = Number(width);
    // Normalise on save too: catches the case where the curator
    // typed/pasted a YouTube watch URL into the explicit "Iframe src
    // URL" input (skipping the iframe-blob textarea path) and clicked
    // Save without re-running the parser.
    const finalSrc = normalizeYouTubeSrc(src.trim());
    const embed: Embed = {
      provider,
      src: finalSrc,
      ...(Number.isFinite(h) && h > 0 ? { height: h } : {}),
      ...(Number.isFinite(w) && w > 0 ? { width: w } : {}),
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
          onPaste={onBlobPaste}
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

      <div className="flex flex-wrap gap-4">
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
        {/*
          Width only needs to be set when the embed is a fixed-layout player
          (Bandcamp big-artwork Standard = 350px). For fluid players, leave
          blank and the iframe fills the card.
        */}
        <div className="flex flex-col gap-2 max-w-[160px]">
          <label className="font-mono text-[9px] uppercase tracking-widest text-mute">
            Width (px, optional)
          </label>
          <input
            type="number"
            inputMode="numeric"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            className="border border-ink bg-paper px-2 py-1 font-mono text-[11px] focus:outline-none focus:bg-paper-2/40"
            placeholder="fluid"
          />
        </div>
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
