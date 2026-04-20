/**
 * Disquet dot-grid mark. 7×5 grid where solid dots form a stylised pair of
 * parenthesis-like shapes around a sparse interior. Same pattern used in
 * public/favicon.svg so the in-page mark and the browser tab favicon match.
 *
 * Pattern (1 = solid, 0 = faint):
 *   1 1 0 1 0 1 1
 *   1 0 1 1 1 0 1
 *   1 0 1 0 1 0 1
 *   1 0 1 1 1 0 1
 *   1 1 0 0 0 1 1
 *
 * Pass `size` to scale; the SVG is transparent so the surrounding page
 * background shows through.
 */
const PATTERN: number[][] = [
  [1, 1, 0, 1, 0, 1, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 0, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 1, 0, 0, 0, 1, 1],
];

export function DotsMark({
  size = 28,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  // viewBox 28 × 20 → 7 cols × 5 rows, each cell 4 units wide, dots centred
  // at (2 + i*4, 2 + j*4) with r=1.6.
  return (
    <svg
      width={size}
      height={(size * 20) / 28}
      viewBox="0 0 28 20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      {PATTERN.flatMap((row, j) =>
        row.map((on, i) => (
          <circle
            key={`${i}-${j}`}
            cx={2 + i * 4}
            cy={2 + j * 4}
            r={1.6}
            fill="currentColor"
            opacity={on ? 1 : 0.15}
          />
        )),
      )}
    </svg>
  );
}
