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
          { color: fg, fontSize: fs(primary ? fontSize.md + 1 : fontSize.md) },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A round icon button floating on the map, or a quiet one in a header. */
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
  return (
    <Pressable
      role="button"
      aria-label={label}
      onPress={onPress}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconButton,
        { backgroundColor: floating ? c.surface : c.tint },
        floating && elevation(c),
        pressed && styles.pressed,
      ]}
    >
      <Icon name={icon} color={c.text} />
    </Pressable>
  );
}

/** A filter chip: on (violet) or off (outlined). Read out as a checkbox. */
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
  return (
    <Pressable
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        on
          ? { backgroundColor: c.primary, borderColor: c.primary }
          : { backgroundColor: c.surface, borderColor: c.border },
        pressed && styles.pressed,
      ]}
    >
      {leading}
      <Text
        style={[
          type.strong,
          { color: on ? c.onPrimary : c.text, fontSize: fs(fontSize.sm + 1) },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled section with a small caps heading. */
export function Section({
  title,
  children,
  aside,
  first = false,
}: {
  title: string;
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
          aria-level={3}
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
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  iconButton: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: "center",
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
    gap: space.sm,
  },
  caps: { letterSpacing: 1.4 },
});
