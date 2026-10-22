import { StyleSheet, Text, View } from "react-native";
import { liveReadout, type LiveData } from "../lib/live";
import { color, font, fontSize, fontWeight, radius, space } from "../theme";

/**
 * A running session's state of charge and power, when the CPO's live-data adapter
 * gives them. Renders nothing when there is neither: most CPOs send OCPI data only.
 * Readings too old to be true now are hidden; a SoC a few minutes old says so.
 */
export function LiveReadout({
  live,
  now,
}: {
  live: LiveData | null | undefined;
  /** The time to judge readings by; defaults to the clock. */
  now?: number;
}) {
  const r = liveReadout(live, now);
  if (r.socPercent === undefined && r.power === undefined) return null;
  return (
    <View style={styles.row} testID="live-readout">
      {r.socPercent !== undefined && (
        <View
          style={styles.soc}
          role="meter"
          aria-label="State of charge"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={r.socPercent}
        >
          <Text style={styles.value}>{r.socPercent}%</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${r.socPercent}%` }]} />
          </View>
          <Text style={styles.label}>
            {r.socAge ? `Battery, ${r.socAge}` : "Battery"}
          </Text>
        </View>
      )}
      {r.power !== undefined && (
        <View>
          <Text style={styles.value}>{r.power}</Text>
          <Text style={styles.label}>Charging power</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.lg, alignItems: "flex-end" },
  soc: { flexGrow: 1, gap: space.xs },
  value: {
    color: color.text,
    fontFamily: font.heading,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  label: { color: color.muted, fontFamily: font.body, fontSize: fontSize.sm },
  track: {
    height: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.border,
    overflow: "hidden",
  },
  fill: { height: "100%", backgroundColor: color.primary },
});
