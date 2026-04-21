"use client";
import { useEffect, useRef, useState } from "react";
import type { Recommendation } from "@/lib/types";
import { useFavorites } from "@/components/FavoriteButton";
import { SITE_URL } from "@/lib/site";

/**
 * Print-ready view of the visitor's saved list. This page is not linked from
 * navigation; it's reached via the "Export as PDF" button on /saved and is
 * meant to be printed (Cmd/Ctrl + P → "Save as PDF") rather than read on
 * screen.
 *
 * Why print-to-PDF instead of a JS PDF library:
 *   - The browser's print engine gives us pixel-perfect typography, proper
 *     page breaks, and native "Save as PDF" UX on every OS. Libraries like
 *     @react-pdf/renderer ship ~500KB, handle fonts poorly, and can't match
 *     CSS layout.
 *   - This page uses pure HTML+CSS with `@media print` rules (defined in
 *     ./print.css), so what shows on screen IS what prints.
 *
 * Layout per record (tuned so 3 fit on A4 / US Letter):
 *   - 80mm cover art on the left.
 *   - Metadata block on the right: artist, title (italic), label · format · date,
 *     tags, description, link back to the site.
 *
 * Auto-print:
 *   We call window.print() once after items render, so the visitor sees the
 *   system print dialog immediately. If they cancel it, the on-screen view
 *   still looks right — they can re-trigger with the toolbar button or
 *   Cmd+P.
 */
export function ExportClient() {
  const { favorites } = useFavorites();
  const [items, setItems] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (favorites.length === 0) {
      setItems([]);
      return;
    }
    const qs = encodeURIComponent(favorites.join(","));
    fetch(`/api/saved?ids=${qs}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: { items: Recommendation[] }) => {
        if (cancelled) return;
        const sorted = [...(json.items || [])].sort((a, b) =>
          b.releaseDate.localeCompare(a.releaseDate),
        );
        setItems(sorted);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load");
        setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [favorites]);

  useEffect(() => {
    // Trigger print once the items have hydrated and the layout is stable.
    // A short timeout lets fonts + cover images paint before the dialog opens.
    if (items && items.length > 0 && !printedOnce.current) {
      printedOnce.current = true;
      const t = setTimeout(() => window.print(), 600);
      return () => clearTimeout(t);
    }
  }, [items]);

  if (items === null) {
    return (
      <div className="p-12 font-mono text-[11px] uppercase tracking-widest text-mute">
        Preparing your PDF…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="p-12 font-mono text-[11px] uppercase tracking-widest text-mute">
        {error ||
          "Nothing saved yet. Go back to /saved and add at least one record."}
      </div>
    );
  }

  return (
    <>
      {/* Toolbar shown only on screen, hidden on print via @media print. */}
      <div className="print-toolbar">
        <div className="toolbar-inner">
          <span className="font-mono text-[10px] uppercase tracking-widest">
            {items.length} record{items.length === 1 ? "" : "s"} — saved from
            disquet.co
          </span>
          <button
            type="button"
            onClick={() => window.print()}
            className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper"
          >
            Save as PDF
          </button>
        </div>
      </div>

      <article className="pdf-sheet">
        <header className="pdf-header">
          <div className="pdf-wordmark">Disquet</div>
          <div className="pdf-subtitle">
            Saved list · {new Date().toISOString().slice(0, 10)}
          </div>
        </header>

        <ul className="pdf-list">
          {items.map((rec) => (
            <li key={rec.id} className="pdf-row">
              {rec.coverImageUrl ? (
                // Small, static cover. No next/image because the print
                // renderer handles plain <img> more reliably across browsers.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={rec.coverImageUrl}
                  alt={`${rec.artist} — ${rec.title}`}
                  className="pdf-cover"
                  loading="eager"
                />
              ) : (
                <div
                  className="pdf-cover pdf-cover-placeholder"
                  style={{ background: rec.cover?.bg || "#111110" }}
                />
              )}

              <div className="pdf-meta">
                <div className="pdf-meta-top">
                  {rec.label} ·{" "}
                  {rec.type === "single"
                    ? "Single"
                    : rec.type === "ep"
                      ? "EP"
                      : "Album"}{" "}
                  · {rec.releaseDate}
                </div>
                <div className="pdf-artist">
                  {rec.artist}
                  <span className="pdf-title"> — {rec.title}</span>
                </div>
                {rec.tags && rec.tags.length > 0 && (
                  <div className="pdf-tags">
                    {rec.tags.slice(0, 4).join(" · ")}
                  </div>
                )}
                {rec.description && (
                  <p className="pdf-description">{rec.description}</p>
                )}
                <div className="pdf-link">
                  {SITE_URL.replace(/^https?:\/\//, "")}/r/{rec.id}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <footer className="pdf-footer">
          Curated at disquet.co · Printed {new Date().toLocaleDateString()}
        </footer>
      </article>
    </>
  );
}
