"use client";
import { useState } from "react";
import type { Recommendation, ReleaseType } from "@/lib/types";
import { CoverArt } from "@/components/CoverArt";
import { EmbedPicker } from "@/components/admin/EmbedPicker";

type LinkKey = "bandcamp" | "spotify" | "soundcloud" | "apple" | "tidal" | "youtube";
const LINK_KEYS: LinkKey[] = ["bandcamp", "spotify", "soundcloud", "apple", "tidal", "youtube"];

export function EditForm({
  rec,
  onSaved,
  onCancel,
  onEmbedSaved,
}: {
  rec: Recommendation;
  onSaved: (r: Recommendation) => void;
  onCancel: () => void;
  /** Fired when the embed picker saves. Updates the list but keeps the
   *  editor open - switching players shouldn't dump the curator out of
   *  editing artist/title/etc. */
  onEmbedSaved?: (r: Recommendation) => void;
}) {
  const [artist, setArtist] = useState(rec.artist);
  const [title, setTitle] = useState(rec.title);
  const [label, setLabel] = useState(rec.label);
  const [type, setType] = useState<ReleaseType>(rec.type);
  const [releaseDate, setReleaseDate] = useState(rec.releaseDate);
  const [description, setDescription] = useState(rec.description);
  const [tagsText, setTagsText] = useState(rec.tags.join(", "));
  const [coverImageUrl, setCoverImageUrl] = useState(rec.coverImageUrl ?? "");
  const [musicVideoUrl, setMusicVideoUrl] = useState(rec.musicVideoUrl ?? "");
  const [links, setLinks] = useState<Record<LinkKey, string>>({
    bandcamp: rec.links.bandcamp ?? "",
    spotify: rec.links.spotify ?? "",
    soundcloud: rec.links.soundcloud ?? "",
    apple: rec.links.apple ?? "",
    tidal: rec.links.tidal ?? "",
    youtube: rec.links.youtube ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewRec: Recommendation = {
    ...rec,
    artist,
    title,
    label,
    type,
    releaseDate,
    coverImageUrl: coverImageUrl || null,
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const cleanLinks: Record<string, string> = {};
    for (const k of LINK_KEYS) {
      const v = links[k].trim();
      if (v) cleanLinks[k] = v;
    }
    const patch = {
      artist: artist.trim(),
      title: title.trim(),
      label: label.trim(),
      type,
      releaseDate: releaseDate.trim(),
      description: description.trim(),
      tags: tagsText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      coverImageUrl: coverImageUrl.trim() || null,
      musicVideoUrl: musicVideoUrl.trim() || null,
      links: cleanLinks,
    };
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rec.id, patch }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "save failed");
      }
      const updated = (await res.json()) as Recommendation;
      onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-ink bg-paper-2/50 px-5 py-5 grid grid-cols-1 md:grid-cols-12 gap-5">
      <div className="md:col-span-3 flex flex-col gap-3">
        <div className="max-w-[200px]">
          <CoverArt rec={previewRec} withLabels={false} />
        </div>
        <Field label="Cover image URL">
          <input
            type="url"
            value={coverImageUrl}
            onChange={(e) => setCoverImageUrl(e.target.value)}
            placeholder="https://…/cover.jpg"
            className={inputCls}
          />
        </Field>
      </div>

      <div className="md:col-span-9 grid grid-cols-1 md:grid-cols-6 gap-3">
        <div className="md:col-span-3">
          <Field label="Artist">
            <input
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="md:col-span-3">
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        <div className="md:col-span-2">
          <Field label="Label">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ReleaseType)}
              className={inputCls}
            >
              <option value="single">Single</option>
              <option value="ep">EP</option>
              <option value="album">Album</option>
            </select>
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Release date (YYYY-MM-DD)">
            <input
              value={releaseDate}
              onChange={(e) => setReleaseDate(e.target.value)}
              placeholder="2026-04-11"
              className={inputCls}
            />
          </Field>
        </div>

        <div className="md:col-span-6">
          <Field label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={inputCls + " leading-relaxed"}
            />
          </Field>
        </div>

        <div className="md:col-span-6">
          <Field label="Tags (comma separated)">
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>

        {LINK_KEYS.map((k) => (
          <div key={k} className="md:col-span-3">
            <Field label={`${k} link`}>
              <input
                type="url"
                value={links[k]}
                onChange={(e) => setLinks({ ...links, [k]: e.target.value })}
                placeholder={`https://…`}
                className={inputCls}
              />
            </Field>
          </div>
        ))}

        {type === "single" && (
          <div className="md:col-span-6">
            <Field label="Music video URL (singles only)">
              <input
                type="url"
                value={musicVideoUrl}
                onChange={(e) => setMusicVideoUrl(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>
        )}

        {/* Player / embed picker. Lives inside the edit form so it isn't in
            the way during normal browsing. Saves independently through the
            same /api/edit route, then bubbles the updated record up. */}
        <div className="md:col-span-6">
          <div className="font-mono text-[9px] uppercase tracking-widest text-mute mb-2">
            Player
          </div>
          <EmbedPicker rec={rec} onSaved={onEmbedSaved ?? onSaved} />
        </div>

        <div className="md:col-span-6 flex items-center gap-3 pt-2 border-t border-ink">
          <button
            onClick={save}
            disabled={saving}
            className="font-mono text-[10px] uppercase tracking-widest bg-ink text-paper border border-ink px-4 py-2 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper disabled:opacity-40"
          >
            Cancel
          </button>
          {error && (
            <span className="font-mono text-[10px] uppercase tracking-widest text-signal">
              {error}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-paper border border-ink px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:bg-paper-2";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[9px] uppercase tracking-widest text-mute">
        {label}
      </span>
      {children}
    </label>
  );
}
