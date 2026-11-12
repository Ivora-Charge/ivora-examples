import type { CSSProperties } from "react";

const mix = (token: string, pct: number, base = "--color-surface") =>
  `color-mix(in srgb, var(${token}) ${pct}%, var(${base}))`;

const WATER: CSSProperties = { fill: mix("--color-ok", 16) };
const LAND: CSSProperties = { fill: "var(--color-bg)" };
const PARK: CSSProperties = { fill: mix("--color-primary", 14) };
const BLOCK: CSSProperties = { fill: mix("--color-text", 6) };
const ROAD: CSSProperties = { stroke: "var(--color-surface)" };
const MAIN_ROAD: CSSProperties = { stroke: mix("--color-accent", 55) };
const SHORE: CSSProperties = { stroke: mix("--color-ok", 30) };

/**
 * Demo mode: a static, made-up map drawn under the sample markers, so the demo
 * loads no tiles. Its colours are the theme's tokens, so it follows light and dark
 * and a new brand without an image to redraw.
 */
export function SampleMap() {
  return (
    <svg
      className="sample-map-art"
      viewBox="0 0 640 320"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="640" height="320" style={WATER} />
      <path
        d="M0 0H300C330 40 290 90 330 130C370 170 420 150 450 200C470 240 440 290 470 320H0Z"
        style={LAND}
      />
      <path d="M60 40H250V120H60Z" style={PARK} />
      <path d="M90 190H230V280H90Z" style={BLOCK} />
      <g fill="none" strokeWidth="9" strokeLinecap="round" style={ROAD}>
        <path d="M0 150H330" />
        <path d="M150 0V320" />
        <path d="M0 70C120 80 200 40 300 60" />
      </g>
      <g fill="none" strokeWidth="5" strokeLinecap="round" style={MAIN_ROAD}>
        <path d="M30 0L260 320" />
        <path d="M0 250H400" />
      </g>
      <g fill="none" strokeWidth="2" style={SHORE}>
        <path d="M520 40C560 80 600 70 640 100" />
        <path d="M500 200C550 230 590 220 640 250" />
      </g>
    </svg>
  );
}
