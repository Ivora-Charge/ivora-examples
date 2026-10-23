import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";

/** A group of choices, read out as one radio group with its label. */
export function ChoiceGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <View role="radiogroup" aria-label={label} style={styles.group}>
      {children}
    </View>
  );
}

/**
 * One choice of a group: a row with a radio mark, a label and a detail line, 56 px or
 * taller. The chosen one has a violet outline and a filled mark, never colour alone.
 */
export function Choice({
  label,
  detail,
  aside,
  selected,
  disabled = false,
  onPress,
  testID,
}: {
  label: string;
  detail?: string;
  aside?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <Pressable
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      aria-label={[label, detail].filter(Boolean).join(", ")}
      onPress={disabled ? undefined : onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: c.surface,
          borderColor: selected ? c.primary : c.border,
        },
        pressed && !disabled && styles.pressed,
      ]}
    >
      <View
        style={[styles.mark, { borderColor: selected ? c.primary : c.muted }]}
      >
        {selected && (
          <View style={[styles.dot, { backgroundColor: c.primary }]} />
        )}
      </View>
      <View style={styles.flex}>
        <Text
          style={[
            type.strong,
            { color: disabled ? c.muted : c.text, fontSize: fs(fontSize.md) },
          ]}
        >
          {label}
        </Text>
        {detail ? (
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      {aside}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { gap: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 4,
    minHeight: 56,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 2,
  },
  pressed: { opacity: 0.85 },
  mark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  flex: { flex: 1, minWidth: 0 },
});
