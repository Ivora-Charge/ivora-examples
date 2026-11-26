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
/**
 * The widest the rail gets, whatever the text size or language: English fits whole at
 * three times the default text size, and the screen beside the rail keeps its room.
 */
const RAIL_MAX_WIDTH = 200;

const TABS: Record<string, { icon: IconName; label: () => string }> = {
  index: { icon: "map", label: () => t("nav.map") },
  charging: { icon: "bolt", label: () => t("nav.charging") },
  wallet: { icon: "wallet", label: () => t("nav.wallet") },
  account: { icon: "user", label: () => t("nav.account") },
};

/**
 * The four tabs: Map, Charging, Wallet, Account. Under the content on phones, a slim
 * rail on the left on wide screens.
 *
 * Labels always show, at the driver's text size. The phone bar is one row while the
 * four fit side by side; when they don't, the second pair wraps under the first (and a
 * pair too wide for the screen stacks). The rail widens with its labels up to
 * `RAIL_MAX_WIDTH`; a longer word breaks inside it.
 */
export function TabBar({
  state,
  navigateToTab,
  insets,
  rail,
}: BottomTabBarProps & { rail: boolean }) {
  const { c } = useTheme();
  const { fs, dim } = useScale();
  // Web: as wide as the longest word, up to the maximum; longer labels wrap between
  // words. Native layout has no min-content, so the width follows the font scale.
  const railWidth =
    Platform.OS === "web"
      ? {
          width: "min-content" as DimensionValue,
          minWidth: RAIL_WIDTH,
          maxWidth: RAIL_MAX_WIDTH,
        }
      : { width: Math.min(dim(RAIL_WIDTH), RAIL_MAX_WIDTH) };
  const tabs = state.routes.map((route, i) => {
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
        // The side padding keeps neighbouring labels apart, more at larger text.
        style={
          rail
            ? styles.railItem
            : [styles.item, { paddingHorizontal: dim(space.xs) }]
        }
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
          // Android hyphenates a word that has to break.
          android_hyphenationFrequency="normal"
          style={[
            on ? type.strong : type.body,
            styles.label,
            { color: fg, fontSize: fs(fontSize.xs + 1) },
          ]}
        >
          {tab.label()}
        </Text>
      </Pressable>
    );
  });
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
        {rail
          ? tabs
          : [tabs.slice(0, 2), tabs.slice(2)].map((pair, i) => (
              <View key={i} style={styles.barPair}>
                {pair}
              </View>
            ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingTop: space.xs, borderTopWidth: 1 },
  barTabs: { flexDirection: "row", flexWrap: "wrap", rowGap: space.sm },
  // Two tabs that wrap together, so the bar never breaks three and one.
  barPair: {
    flexDirection: "row",
    flexWrap: "wrap",
    flexGrow: 1,
    maxWidth: "100%",
    rowGap: space.sm,
  },
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
  // As wide as its label needs, plus an equal share of what is left of the row.
  item: {
    flexGrow: 1,
    maxWidth: "100%",
    alignItems: "center",
    gap: 2,
    minHeight: 48,
  },
  railItem: { alignItems: "center", gap: 2, minHeight: 64 },
  label: { maxWidth: "100%", textAlign: "center" },
  barPill: { height: 28 },
  pill: {
    width: 60,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
