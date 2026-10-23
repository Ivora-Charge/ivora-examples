import { StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import { liveReadout, type LiveData } from "../lib/live";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";

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
  const { c } = useTheme();
  const { fs } = useScale();
  const r = liveReadout(live, now);
  if (r.socPercent === undefined && r.power === undefined) return null;
  const value = [type.heading, { color: c.text, fontSize: fs(fontSize.lg) }];
  const label = [type.body, { color: c.muted, fontSize: fs(fontSize.sm) }];
  return (
    <View style={styles.row} testID="live-readout">
      {r.socPercent !== undefined && (
        <View
          style={styles.soc}
          role="meter"
          aria-label={t("live.soc")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={r.socPercent}
        >
          <Text style={value}>{r.socPercent}%</Text>
          <View style={[styles.track, { backgroundColor: c.border }]}>
            <View
              style={[
                styles.fill,
                { width: `${r.socPercent}%`, backgroundColor: c.primary },
              ]}
            />
          </View>
          <Text style={label}>
            {r.socAge
              ? t("live.batteryAge", { age: r.socAge })
              : t("live.battery")}
          </Text>
        </View>
      )}
      {r.power !== undefined && (
        <View>
          <Text style={value}>{r.power}</Text>
          <Text style={label}>{t("live.power")}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.lg, alignItems: "flex-end" },
  soc: { flexGrow: 1, gap: space.xs },
  track: { height: space.sm, borderRadius: radius.sm, overflow: "hidden" },
  fill: { height: "100%" },
});
