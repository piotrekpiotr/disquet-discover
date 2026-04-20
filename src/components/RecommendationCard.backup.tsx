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

export function RecommendationCard({ rec, index }: { rec: Recommendation; index: number }) {
  const num = String(index + 1).padStart(2, "0");
  return (
    <article className="border-t border-ink py-10 sm:py-14 px-6 sm:px-8 grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10">
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

      {/* Body */}
      <div className="md:col-span-6 flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h2
            className="font-display font-black text-[40px] sm:text-[56px] leading-[0.95] mt-[-0.1em]"
            style={{ letterSpacing: "-0.035em" }}
          >
            {rec.artist}
            <span
              className="font-serif italic font-normal text-mute text-[0.58em] block leading-[1.15] mt-2"
              style={{ letterSpacing: "0.005em" }}
            >
              {rec.title}
            </span>
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

        <EmbedPlayer
          embed={rec.embed}
          musicVideoUrl={rec.type === "single" ? rec.musicVideoUrl : null}
          links={rec.links}
        />

        <div className="flex items-center gap-4">
          <FavoriteButton id={rec.id} />
        </div>
      </div>
    </article>
  );
}
