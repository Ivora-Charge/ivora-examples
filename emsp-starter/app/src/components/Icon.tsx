import Svg, { Circle, Path } from "react-native-svg";

/**
 * The app's own line icons, 24 px grid, 2 px stroke, round ends. Decorative: the
 * control that holds one carries the label.
 */
const PATHS = {
  search: ["M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z", "m16 16 5 5"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  locate: ["M20.5 3.5 3.5 10.6l7 2.9 2.9 7 7.1-17Z"],
  map: [
    "M9 4 3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4Z",
    "M9 4v13.5",
    "M15 6.5V20",
  ],
  bolt: ["M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8Z"],
  wallet: [
    "M4 7.5h15a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5h11",
    "M16 13.5h.01",
  ],
  user: [
    "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M4.5 20.5c1-3.6 4-5.5 7.5-5.5s6.5 1.9 7.5 5.5",
  ],
  plug: [
    "M9 3v5",
    "M15 3v5",
    "M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8Z",
    "M12 16.5V21",
  ],
  directions: ["M5 20v-7a4 4 0 0 1 4-4h10", "m15 5 4 4-4 4"],
  back: ["M15 5l-7 7 7 7"],
  stepFree: [
    "M11 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
    "M11 7v6h5l2 5",
    "M8 9.5a6 6 0 1 0 7.5 8.3",
  ],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  mail: ["M3.5 6.5h17v11h-17z", "m4 7 8 6 8-6"],
  star: [
    "m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z",
  ],
  scan: [
    "M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8",
    "M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8",
    "M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16",
    "M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16",
    "M8 8h3v3H8z",
    "M13 13h3v3h-3z",
    "M13 8h3",
    "M8 16h3",
  ],
  card: ["M3.5 6h17v12h-17z", "M3.5 10h17", "M7 15h4"],
  receipt: [
    "M6 3.5h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5v-17Z",
    "M9 8h6",
    "M9 12h6",
    "M9 16h3",
  ],
  flag: ["M5 21V4", "M5 4h11l-2 4 2 4H5"],
  stop: ["M7 7h10v10H7z"],
  camera: [
    "M4 8h3l1.5-2.5h7L17 8h3v11H4z",
    "M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  ],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  color,
  size = 22,
  filled = false,
}: {
  name: IconName;
  color: string;
  size?: number;
  /** Filled as well as outlined: an "on" state, such as a favourite's star. */
  filled?: boolean;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      focusable={false}
    >
      {PATHS[name].map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color}
          fill={filled ? color : "none"}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/** The status glyphs: filled dot, half dot, cross, dashed ring. Never colour alone. */
export function StatusGlyph({
  kind,
  color,
  size = 12,
}: {
  kind: "free" | "busy" | "down" | "unknown";
  color: string;
  size?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      aria-hidden
      focusable={false}
    >
      {kind === "free" && <Circle cx={6} cy={6} r={5.5} fill={color} />}
      {kind === "busy" && (
        <>
          <Circle
            cx={6}
            cy={6}
            r={4.75}
            stroke={color}
            strokeWidth={1.5}
            fill="none"
          />
          <Path d="M6 1.25a4.75 4.75 0 0 0 0 9.5Z" fill={color} />
        </>
      )}
      {kind === "down" && (
        <Path
          d="M2 2l8 8M10 2 2 10"
          stroke={color}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      )}
      {kind === "unknown" && (
        <Circle
          cx={6}
          cy={6}
          r={4.75}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="2 2"
          fill="none"
        />
      )}
    </Svg>
  );
}
