/**
 * Disquet primary mark, Archivo 900, rendered as text for crispness.
 * Paired with a hairline rule and catalog metadata (v9 from the identity sheet).
 */
export function Wordmark({
  size = "md",
  sub = "discover",
}: {
  size?: "sm" | "md" | "lg";
  sub?: string;
}) {
  const sizes = {
    sm: "text-[22px]",
    md: "text-[32px]",
    lg: "text-[56px]",
  };
  return (
    <div className="inline-flex flex-col leading-none">
      <div className="flex items-baseline gap-3">
        <span
          className={`font-display font-black ${sizes[size]} tracking-tightest`}
          style={{ letterSpacing: "-0.05em" }}
        >
          Disquet
        </span>
        {sub ? (
          <span className="font-serif italic text-mute text-[0.45em] leading-none relative top-[-0.15em]">
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function DotsMark({ size = 32 }: { size?: number }) {
  // 7x5 grid recreated faithfully from the Disquet dots pattern
  const pattern = [
    [1, 1, 0, 1, 0, 1, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 0, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 1, 0, 0, 0, 1, 1],
  ];
  const cell = size / 10;
  const gap = cell * 0.4;
  const w = 7 * cell + 6 * gap;
  const h = 5 * cell + 4 * gap;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-label="Disquet"
      className="shrink-0"
    >
      {pattern.map((row, r) =>
        row.map((on, c) => (
          <circle
            key={`${r}-${c}`}
            cx={c * (cell + gap) + cell / 2}
            cy={r * (cell + gap) + cell / 2}
            r={cell / 2}
            fill={on ? "currentColor" : "currentColor"}
            opacity={on ? 1 : 0.12}
          />
        )),
      )}
    </svg>
  );
}
