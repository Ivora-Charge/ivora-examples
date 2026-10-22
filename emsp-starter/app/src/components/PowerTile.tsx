import { StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, Pattern, Rect } from "react-native-svg";
import { t } from "../i18n";
import type { StatusKind } from "../lib/status";
import {
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  type Palette,
} from "../theme";

/** The colours of a tile: fill, outline and text, by status. */
export function tileColors(kind: StatusKind, c: Palette) {
  switch (kind) {
    case "free":
      return { fill: c.free, line: c.free, text: c.onStatus };
    case "busy":
      return { fill: c.surface, line: c.busy, text: c.busy };
    case "down":
      return { fill: c.surface, line: c.danger, text: c.danger };
    default:
      return { fill: c.surface, line: c.muted, text: c.muted };
  }
}

/**
 * A charger as a rounded-square power tile showing its maximum kW. Its shape carries
 * the status as well as its colour: filled (free), outlined (in use), hatched (out of
 * order) or dashed (unknown). It grows with the driver's text size. The row or marker
 * that holds it says the status in words.
 */
export function PowerTile({
  kw,
  kind,
  size = 56,
  selected = false,
  pin = false,
  announce = false,
}: {
  kw: number;
  kind: StatusKind;
  size?: number;
  selected?: boolean;
  /** A small pointer under the tile, for the map. */
  pin?: boolean;
  /** Read the kW out (in a list row named by its text); else the holder says it. */
  announce?: boolean;
}) {
  const { c } = useTheme();
  const { fs, dim } = useScale();
  const col = tileColors(kind, c);
  const big = size >= 52;
  const value = kw >= 100 ? Math.round(kw) : Math.round(kw * 10) / 10;
  return (
    <View style={styles.wrap} aria-hidden={!announce}>
      <View
        style={[
          styles.ring,
          {
            borderColor: selected ? c.selected : "transparent",
            borderRadius: radius.md + 4,
          },
        ]}
      >
        <View
          style={[
            styles.tile,
            {
              minWidth: dim(size),
              minHeight: dim(size),
              backgroundColor: col.fill,
              borderColor: col.line,
              borderStyle: kind === "unknown" ? "dashed" : "solid",
            },
          ]}
        >
          {kind === "down" && (
            <Svg style={StyleSheet.absoluteFill} aria-hidden focusable={false}>
              <Defs>
                <Pattern
                  id="hatch"
                  patternUnits="userSpaceOnUse"
                  width={7}
                  height={7}
                  patternTransform="rotate(45)"
                >
                  <Line
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={7}
                    stroke={col.line}
                    strokeWidth={2}
                    strokeOpacity={0.22}
                  />
                </Pattern>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#hatch)" />
            </Svg>
          )}
          {/* One text, number and unit on two lines, so the tile reads "150 kW". */}
          <Text
            style={[
              type.heading,
              styles.kw,
              {
                color: col.text,
                fontSize: fs(big ? fontSize.lg : fontSize.md),
              },
            ]}
          >
            {value}
            {"\n"}
            <Text
              style={[
                type.strong,
                styles.unit,
                { color: col.text, fontSize: fs(fontSize.xs) },
              ]}
            >
              {t("unit.kw", { n: "" }).trim()}
            </Text>
          </Text>
        </View>
      </View>
      {pin && (
        <View
          style={[
            styles.pointer,
            { backgroundColor: kind === "free" ? col.fill : col.line },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center" },
  ring: { borderWidth: 3, padding: 2 },
  tile: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2.5,
    borderRadius: radius.md,
    paddingHorizontal: space.xs + 2,
    paddingVertical: space.xs,
    overflow: "hidden",
  },
  kw: { letterSpacing: -0.5, textAlign: "center" },
  unit: { letterSpacing: 0.6 },
  pointer: {
    width: 10,
    height: 10,
    marginTop: -8,
    transform: [{ rotate: "45deg" }],
    borderRadius: 2,
  },
});
