export interface Bar {
  label: string;
  value: number;
}

const W = 640;
const H = 200;
const TOP = 10;

/**
 * Bars in one colour (`--color-primary`), gridlines in the border token. It is a
 * figure with a text equivalent: `summary` names it for screen readers and the page
 * keeps the same figures in a table. Every label is drawn only as often as it fits.
 */
export function BarChart({
  bars,
  summary,
  unit,
}: {
  bars: Bar[];
  summary: string;
  unit: string;
}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const step = W / Math.max(1, bars.length);
  const width = Math.max(1, step * 0.8);
  const every = Math.max(1, Math.ceil(bars.length / 12));
  const plot = H - TOP;
  return (
    <svg
      className="bars"
      viewBox={`0 0 ${W} ${H + 24}`}
      role="img"
      aria-label={summary}
      width="100%"
    >
      <g className="grid">
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={H - plot * f} y2={H - plot * f} />
        ))}
      </g>
      {bars.map((b, i) => {
        const h = (b.value / max) * plot;
        const x = i * step + (step - width) / 2;
        return (
          <g key={`${b.label}-${i}`}>
            <rect
              x={x}
              y={H - h}
              width={width}
              height={Math.max(h, b.value > 0 ? 1 : 0)}
              rx="2"
            >
              <title>{`${b.label}: ${b.value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`}</title>
            </rect>
            {i % every === 0 && (
              <text x={x + width / 2} y={H + 16} textAnchor="middle">
                {b.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
