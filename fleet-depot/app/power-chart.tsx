"use client";
import { useEffect, useRef, useState } from "react";

import type { State } from "./types";
import { clock } from "@/lib/timeline";

const H = 230;
const M = { l: 38, r: 10, t: 12, b: 26 };
const HOUR = 3600_000;

/** Width of an element in px, kept up to date; 0 until it is measured. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.floor(el.clientWidth)));
    ro.observe(el);
    setW(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * Site power for the night against the cap, with the "without load management"
 * comparison. The axes are fixed for the whole night, so a clock tick only extends the lines.
 */
export default function PowerChart({
  s,
  tall = false,
}: {
  s: State;
  tall?: boolean;
}) {
  const [ref, w] = useWidth();
  const sim = s.sim;
  if (!sim) return null;
  const cap = s.settings.siteCapKw;
  const h = tall ? 300 : H;
  const x = (t: number) =>
    M.l + ((t - sim.start) / (sim.end - sim.start)) * (w - M.l - M.r);
  const y = (kw: number) => h - M.b - (kw / sim.axisMaxKw) * (h - M.t - M.b);
  const line = (i: 1 | 2) =>
    sim.samples
      .map(
        (p, n) => `${n ? "L" : "M"}${x(p[0]).toFixed(1)} ${y(p[i]).toFixed(1)}`,
      )
      .join("");
  const last = sim.samples.at(-1);
  const area =
    last && sim.samples.length > 1
      ? `${line(1)}L${x(last[0]).toFixed(1)} ${y(0)}L${x(sim.samples[0][0]).toFixed(1)} ${y(0)}Z`
      : "";
  const hours: number[] = [];
  for (let t = Math.ceil(sim.start / HOUR) * HOUR; t <= sim.end; t += HOUR)
    if (new Date(t).getHours() % 3 === 0) hours.push(t);
  const yTicks: number[] = [];
  for (let k = 0; k <= sim.axisMaxKw; k += 50) yTicks.push(k);
  const label = `Site power over the night. Peak ${sim.peakKw.toFixed(0)} kW against the ${cap} kW cap, compared with ${sim.ghostPeakKw.toFixed(0)} kW without load management.`;
  return (
    <section className="panel chart" aria-labelledby="chart-h">
      <h2 id="chart-h">Site power tonight</h2>
      <p className="peaks num">
        <span>
          Peak <b>{sim.peakKw.toFixed(0)} kW</b>
        </span>{" "}
        <span className="vs">vs</span>{" "}
        <span>
          <b>{sim.ghostPeakKw.toFixed(0)} kW</b> unmanaged
        </span>
      </p>
      <div ref={ref} className="chartbox" style={{ height: h }}>
        {w > 0 && (
          <svg width={w} height={h} role="img" aria-label={label}>
            {yTicks.map((k) => (
              <g key={k}>
                <line
                  x1={M.l}
                  x2={w - M.r}
                  y1={y(k)}
                  y2={y(k)}
                  stroke="var(--line)"
                />
                <text
                  x={M.l - 6}
                  y={y(k) + 4}
                  textAnchor="end"
                  className="axis"
                >
                  {k}
                </text>
              </g>
            ))}
            {hours.map((t) => (
              <text
                key={t}
                x={x(t)}
                y={h - 8}
                textAnchor="middle"
                className="axis"
              >
                {clock(t)}
              </text>
            ))}
            {area && <path d={area} fill="var(--accent)" opacity="0.16" />}
            {sim.samples.length > 1 && (
              <path
                d={line(2)}
                fill="none"
                stroke="var(--muted)"
                strokeWidth="2"
                strokeDasharray="6 4"
              />
            )}
            {sim.samples.length > 1 && (
              <path
                d={line(1)}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2.5"
              />
            )}
            <line
              x1={M.l}
              x2={w - M.r}
              y1={y(cap)}
              y2={y(cap)}
              stroke="var(--ink)"
              strokeWidth="2"
            />
            <text x={M.l + 6} y={y(cap) - 6} className="axis cap-l">
              {cap} kW cap
            </text>
          </svg>
        )}
      </div>
      <ul className="legend" aria-label="Chart legend">
        <li>
          <i className="sw line" />
          Actual, held under the cap
        </li>
        <li>
          <i className="sw ghost" />
          Without load management (comparison)
        </li>
      </ul>
      <p className="note small">
        The dashed line is a comparison, not a measurement: every plugged-in
        vehicle at its charger&apos;s full rating (or the vehicle&apos;s own
        limit if lower), computed from the same demo data.
      </p>
    </section>
  );
}
