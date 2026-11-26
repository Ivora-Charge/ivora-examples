import type { BottomTabBarProps } from "expo-router/js-tabs";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from "react-native";
import { t } from "../i18n";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Mark } from "./Logo";

/** The rail's width when its labels need no more. */
const RAIL_WIDTH = 92;

const TABS: Record<string, { icon: IconName; label: () => string }> = {
  index: { icon: "map", label: () => t("nav.map") },
  charging: { icon: "bolt", label: () => t("nav.charging") },
  wallet: { icon: "wallet", label: () => t("nav.wallet") },
  account: { icon: "user", label: () => t("nav.account") },
};

/**
 * The four tabs: Map, Charging, Wallet, Account. Under the content on phones, a slim
 * rail on the left on wide screens.
 */
export function TabBar({
  state,
  navigateToTab,
  insets,
  rail,
}: BottomTabBarProps & { rail: boolean }) {
  const { c } = useTheme();
  const { fs, dim } = useScale();
  // Web: as wide as the longest word, at any text size and in any language; longer
  // labels wrap between words. Native layout has no min-content, so the width follows
  // the font scale.
  const railWidth =
    Platform.OS === "web"
      ? { width: "min-content" as DimensionValue, minWidth: RAIL_WIDTH }
      : { width: dim(RAIL_WIDTH) };
  return (
    <View
      role="navigation"
      aria-label={t("nav.label")}
      style={[
        rail ? [styles.rail, railWidth] : styles.bar,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          paddingBottom: rail ? space.md : Math.max(insets.bottom, space.xs),
        },
      ]}
    >
      {rail && (
        <View style={styles.mark}>
          <Mark size={34} />
        </View>
      )}
      <View role="tablist" style={rail ? styles.railTabs : styles.barTabs}>
        {state.routes.map((route, i) => {
          const tab = TABS[route.name];
          if (!tab) return null;
          const on = state.index === i;
          const fg = on ? c.text : c.muted;
          return (
            <Pressable
              key={route.key}
              role="tab"
              aria-selected={on}
              aria-label={tab.label()}
              onPress={() => navigateToTab(route.key)}
              testID={`tab-${route.name}`}
              style={rail ? styles.railItem : styles.item}
            >
              <View
                style={[
                  styles.pill,
                  !rail && styles.barPill,
                  on && { backgroundColor: c.tint },
                ]}
              >
                <Icon name={tab.icon} color={on ? c.primary : fg} />
              </View>
              <Text
                style={[
                  on ? type.strong : type.body,
                  rail && styles.railLabel,
                  { color: fg, fontSize: fs(fontSize.xs + 1) },
                ]}
              >
                {tab.label()}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingTop: space.xs, borderTopWidth: 1 },
  barTabs: { flexDirection: "row", justifyContent: "space-around" },
  // The side padding leaves room for a tab's focus ring.
  railTabs: {
    alignSelf: "stretch",
    gap: space.sm,
    paddingHorizontal: space.sm,
  },
  rail: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
    borderRightWidth: 1,
  },
  mark: { paddingBottom: space.md },
  item: { flex: 1, alignItems: "center", gap: 2, minHeight: 48 },
  railItem: { alignItems: "center", gap: 2, minHeight: 64 },
  railLabel: { textAlign: "center" },
  barPill: { height: 28 },
  pill: {
    width: 60,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
