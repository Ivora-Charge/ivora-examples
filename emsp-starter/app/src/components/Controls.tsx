import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  brand,
  elevation,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";
import { Icon, type IconName } from "./Icon";

/**
 * The primary action (violet, 56 px) or a secondary one (2 px ink outline). Never a
 * browser-default button: every state comes from the brand tokens.
 */
export function Button({
  label,
  onPress,
  variant = "primary",
  icon,
  busy = false,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  icon?: IconName;
  busy?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const primary = variant === "primary";
  const fg = primary ? c.onPrimary : c.text;
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-busy={busy}
      onPress={busy ? undefined : onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: c.primary, borderColor: c.primary }
          : { backgroundColor: c.surface, borderColor: c.text },
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        icon && (
          <View style={styles.icon}>
            <Icon name={icon} color={fg} size={20} />
          </View>
        )
      )}
      <Text
        style={[
          primary ? type.heading : type.strong,
          styles.label,
          { color: fg, fontSize: fs(primary ? fontSize.md + 1 : fontSize.md) },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A round icon button floating on the map (the smallest tap target on phones), or a
 * quiet one in a header.
 */
export function IconButton({
  icon,
  label,
  onPress,
  floating = false,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  floating?: boolean;
  testID?: string;
}) {
  const { c } = useTheme();
  const compact = !useWide() && floating;
  return (
    <Pressable
      role="button"
      aria-label={label}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconButton,
        compact && styles.iconButtonCompact,
        { backgroundColor: floating ? c.surface : c.tint },
        floating && elevation(c),
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} color={c.text} />
    </Pressable>
  );
}

/**
 * A filter chip: on (violet) or off (outlined). Read out as a checkbox. On phones the
 * pill is smaller than the tap target around it.
 */
export function Chip({
  label,
  on,
  onPress,
  leading,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  leading?: ReactNode;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const compact = !useWide();
  return (
    <Pressable
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onPress={onPress}
      // Web: the focus ring goes inside the phone's tap target (see WebStyles), where
      // the scrolling row cannot clip it. React Native's types lack `dataSet`.
      {...((compact ? { dataSet: { chip: "true" } } : {}) as object)}
      style={[styles.chipTarget, compact && styles.chipTargetCompact]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.chip,
            compact && styles.chipCompact,
            on
              ? { backgroundColor: c.primary, borderColor: c.primary }
              : { backgroundColor: c.surface, borderColor: c.border },
            pressed && styles.pressed,
          ]}
        >
          {leading}
          <Text
            style={[
              compact ? type.medium : type.strong,
              {
                color: on ? c.onPrimary : c.text,
                fontSize: fs(compact ? fontSize.sm : fontSize.smd),
              },
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** A labelled section with a small caps heading. */
export function Section({
  title,
  children,
  aside,
  first = false,
  level = 2,
}: {
  title: string;
  /** The heading level: one below the screen's or card's own heading. */
  level?: 2 | 3;
  children: ReactNode;
  aside?: ReactNode;
  /** The first section has no rule above it. */
  first?: boolean;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View
      style={[
        styles.section,
        first ? styles.firstSection : { borderTopColor: c.border },
      ]}
    >
      <View style={styles.sectionHead}>
        <Text
          role="heading"
          aria-level={level}
          style={[
            type.strong,
            styles.caps,
            { color: c.muted, fontSize: fs(fontSize.xs) },
          ]}
        >
          {title.toUpperCase()}
        </Text>
        {aside}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    minHeight: 56,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 2,
  },
  icon: { flexShrink: 0 },
  label: { flexShrink: 1, textAlign: "center" },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  iconButton: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonCompact: {
    width: brand.minTapTarget,
    height: brand.minTapTarget,
  },
  chipTarget: { borderRadius: radius.pill },
  // The padding is the space between chips: the row itself adds none.
  chipTargetCompact: {
    minHeight: brand.minTapTarget,
    minWidth: brand.minTapTarget,
    padding: space.xs,
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    minHeight: brand.minTapTarget,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },
  chipCompact: {
    justifyContent: "center",
    minHeight: brand.minTapTarget - space.sm,
    paddingHorizontal: space.sm + space.xs,
  },
  section: {
    gap: space.sm,
    paddingTop: space.md,
    marginTop: space.md,
    borderTopWidth: 1,
  },
  firstSection: { borderTopWidth: 0, marginTop: 0 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space.sm,
  },
  caps: { letterSpacing: 1.4 },
});
