export interface Bar {
  label: string;
  value: number;
}

// The bars are drawn in a 100 x 100 box stretched to the chart's size, so the chart
// fills whatever height its card has; the labels are in the outer box, in pixels, so
// text never stretches.
const PLOT = 100;
const TOP = 5;

/**
 * Bars in one colour (`--color-primary`), gridlines in the border token. It is a
 * figure with a text equivalent: `summary` names it for screen readers and the page
 * keeps the same figures in a table. Every label is drawn only as often as it fits.
 * Its height comes from CSS (`svg.bars`), so a card can let it grow.
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
  const step = PLOT / Math.max(1, bars.length);
  const width = step * 0.8;
  const every = Math.max(1, Math.ceil(bars.length / 12));
  const plot = PLOT - TOP;
  const pct = (n: number) => `${n}%`;
  return (
    <svg className="bars" role="img" aria-label={summary} width="100%">
      <svg
        className="plot"
        viewBox={`0 0 ${PLOT} ${PLOT}`}
        preserveAspectRatio="none"
        width="100%"
        height="88%"
      >
        <g className="grid">
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1="0"
              x2={PLOT}
              y1={PLOT - plot * f}
              y2={PLOT - plot * f}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        {bars.map((b, i) => {
          const h = (b.value / max) * plot;
          return (
            <rect
              key={`${b.label}-${i}`}
              x={i * step + (step - width) / 2}
              y={PLOT - h}
              width={width}
              height={b.value > 0 ? Math.max(h, 0.5) : 0}
            >
              <title>{`${b.label}: ${b.value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`}</title>
            </rect>
          );
        })}
      </svg>
      {bars.map((b, i) =>
        i % every === 0 ? (
          <text
            key={`${b.label}-${i}`}
            x={pct(i * step + step / 2)}
            y="100%"
            dy="-6"
            textAnchor="middle"
          >
            {b.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}
