import { StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import {
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";

/**
 * The flare strip on every screen while the app or its server is in demo mode. It
 * cannot be dismissed, and it wraps rather than cuts its text on narrow screens.
 */
export function DemoBanner({ offline }: { offline: boolean }) {
  const { c } = useTheme();
  const { fs } = useScale();
  const compact = !useWide();
  return (
    <View
      style={[
        styles.banner,
        compact && styles.bannerCompact,
        { backgroundColor: c.demoBackground },
      ]}
      role="region"
      aria-label={t("demo.label")}
      aria-live="polite"
      testID="demo-banner"
    >
      <Text
        style={[
          type.heading,
          styles.badge,
          {
            backgroundColor: c.onFlare,
            color: c.flare,
            fontSize: fs(fontSize.xs),
          },
        ]}
      >
        {t("demo.badge").toUpperCase()}
      </Text>
      <Text
        style={[
          compact ? type.body : type.strong,
          styles.text,
          {
            color: c.demoText,
            fontSize: fs(compact ? fontSize.xs : fontSize.sm),
          },
        ]}
      >
        {offline ? t("demo.offline") : t("demo.server")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  bannerCompact: {
    gap: space.sm,
    paddingHorizontal: space.sm + space.xs,
    paddingVertical: space.xs,
  },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    letterSpacing: 1,
    overflow: "hidden",
  },
  text: { flex: 1, flexShrink: 1 },
});
