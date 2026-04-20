import type { Recommendation } from "@/lib/types";

/**
 * Cover artwork:
 * - When `coverImageUrl` is set, renders the real image with label metadata
 *   placed *around* (above/below) the image so the artwork isn't obscured.
 * - Otherwise, renders a consistent dark-vinyl fallback (ink ground, paper
 *   vinyl disc with grooves) matching the Skee Mask placeholder look. The
 *   per-item motif colours are ignored on purpose: one cohesive fallback.
 */
export function CoverArt({
  rec,
  withLabels = true,
}: {
  rec: Recommendation;
  withLabels?: boolean;
}) {
  const { artist, label, coverImageUrl } = rec;
  const formatCode = rec.type === "single" ? "7″" : rec.type === "ep" ? "12″ EP" : "LP";
  const monthCode = rec.releaseDate.slice(0, 7);

  if (coverImageUrl) {
    return (
      <figure className="w-full">
        <div className="relative aspect-square w-full overflow-hidden bg-paper-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverImageUrl}
            alt={`${artist} - ${rec.title}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        </div>
        {withLabels && (
          <figcaption className="flex flex-col gap-1 pt-2 font-mono text-[9px] uppercase tracking-widest text-mute">
            <div className="flex items-start justify-between">
              <span className="truncate max-w-[60%]">{label || "\u2014"}</span>
              <span>{formatCode}</span>
            </div>
            <div className="flex items-start justify-between">
              <span className="truncate max-w-[60%]">{artist}</span>
              <span>{monthCode}</span>
            </div>
          </figcaption>
        )}
      </figure>
    );
  }

  // Dark-vinyl fallback (same look for every unmatched item)
  const bg = "#111110"; // ink
  const fg = "#f2efe8"; // paper
  return (
    <div
      className="relative aspect-square w-full overflow-hidden"
      style={{ background: bg, color: fg }}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 w-full h-full"
        aria-hidden="true"
      >
        {/* Vinyl body */}
        <circle cx="50" cy="50" r="38" fill={fg} />
        {/* Concentric grooves */}
        {Array.from({ length: 9 }).map((_, i) => (
          <circle
            key={i}
            cx="50"
            cy="50"
            r={10 + i * 3}
            fill="none"
            stroke={bg}
            strokeWidth="0.25"
            opacity={0.55}
          />
        ))}
        {/* Label + spindle */}
        <circle cx="50" cy="50" r="8" fill={bg} />
        <circle cx="50" cy="50" r="8" fill="none" stroke={fg} strokeWidth="0.5" opacity="0.4" />
        <circle cx="50" cy="50" r="0.9" fill={fg} />
        {/* Highlight arc */}
        <path
          d="M 18 50 A 32 32 0 0 1 50 18"
          fill="none"
          stroke={bg}
          strokeWidth="0.6"
          opacity="0.25"
        />
      </svg>
      {withLabels && (
        <>
          <div className="absolute top-3 left-3 right-3 flex items-start justify-between font-mono text-[9px] uppercase tracking-widest opacity-70">
            <span className="truncate max-w-[55%]">{label}</span>
            <span>{formatCode}</span>
          </div>
          <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between font-mono text-[9px] uppercase tracking-widest opacity-70">
            <span className="truncate max-w-[60%]">{artist}</span>
            <span>{monthCode}</span>
          </div>
        </>
      )}
    </div>
  );
}
