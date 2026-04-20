import Link from "next/link";
import type { Recommendation } from "@/lib/types";
import { CoverArt } from "./CoverArt";
import { EmbedPlayer } from "./EmbedPlayer";
import { FavoriteButton } from "./FavoriteButton";

function typeLabel(t: Recommendation["type"]) {
  return t === "single" ? "Single" : t === "ep" ? "EP" : "Album";
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Card layout:
 *
 *   Row 1 (header): meta rail (2 cols) | cover (4 cols) | body text (6 cols)
 *   Row 2 (player): indent (2 cols)    | player + favorite (10 cols)
 *
 * The player lives on its own row so a 450px Apple embed doesn't force the
 * text column to balloon out of sync with the square cover. The 2-col indent
 * aligns the player's left edge with the cover art, so the record reads as a
 * single compound block rather than two detached pieces.
 */
export function RecommendationCard({ rec, index }: { rec: Recommendation; index: number }) {
  const num = String(index + 1).padStart(2, "0");
  return (
    <article className="border-t border-ink py-10 sm:py-14 px-6 sm:px-8 grid grid-cols-1 md:grid-cols-12 gap-x-6 md:gap-x-10 gap-y-6">
      {/* Index + meta rail */}
      <div className="md:col-span-2 flex md:flex-col items-start justify-between md:justify-start md:gap-5 font-mono text-[10px] uppercase tracking-widest text-mute">
        <span className="text-ink">N° {num}</span>
        <span>{typeLabel(rec.type)}</span>
        <span className="flex flex-col md:gap-0.5">
          <span className="text-[9px] opacity-70">Released</span>
          <span className="text-ink">{formatDate(rec.releaseDate)}</span>
        </span>
      </div>

      {/* Cover */}
      <div className="md:col-span-4">
        <div className="max-w-[440px]">
          <CoverArt rec={rec} />
        </div>
      </div>

      {/* Body text */}
      <div className="md:col-span-6 flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          {/* Artist + title is the link anchor to the record's own page.
              Keeps internal linking dense (every feed item -> its own /r/[id]
              URL) which matters for SEO crawl + for LLM retrieval picking
              up the per-record structured data. The Link wraps the whole
              heading; the subtitle stays styled because of the block span
              inside. */}
          <h2
            className="font-display font-black text-[40px] sm:text-[56px] leading-[0.95] mt-[-0.1em]"
            style={{ letterSpacing: "-0.035em" }}
          >
            <Link
              href={`/r/${rec.id}`}
              className="no-underline text-ink hover:text-signal transition-colors"
            >
              {rec.artist}
              <span
                className="font-serif italic font-normal text-mute text-[0.58em] block leading-[1.15] mt-2"
                style={{ letterSpacing: "0.005em" }}
              >
                {rec.title}
              </span>
            </Link>
          </h2>
          {rec.label ? (
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute pt-1">
              {rec.label}
            </div>
          ) : null}
        </header>

        <p className="font-body text-[17px] sm:text-[19px] leading-[1.45] max-w-[58ch]">
          {rec.description}
        </p>

        {rec.tags.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-mute">
            {rec.tags.map((t) => (
              <li key={t}>- {t}</li>
            ))}
          </ul>
        )}
      </div>

      {/* Row 2: player spans cover + body width, indented past the meta rail */}
      <div className="md:col-start-3 md:col-span-10 flex flex-col gap-4">
        <EmbedPlayer
          embed={rec.embed}
          musicVideoUrl={rec.type === "single" ? rec.musicVideoUrl : null}
          links={rec.links}
          searchQuery={`${rec.artist} ${rec.title}`}
        />
        <div className="flex items-center justify-between gap-4 pt-1">
          <FavoriteButton id={rec.id} />
        </div>
      </div>
    </article>
  );
}
