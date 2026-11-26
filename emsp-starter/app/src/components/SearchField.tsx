import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { t } from "../i18n";
import {
  brand,
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";
import { Icon } from "./Icon";

/**
 * The search box: place, charger or EVSE ID. In thumb reach on phones, where it is
 * 48 px high; 60 px on wide screens. Its text stays at 16 px or more: iOS Safari
 * zooms the page when a smaller input takes focus.
 */
export function SearchField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const compact = !useWide();
  return (
    <View
      style={[
        styles.field,
        compact && styles.fieldCompact,
        { borderColor: c.text, backgroundColor: c.surface },
      ]}
    >
      <Icon name="search" color={c.text} />
      <TextInput
        value={value}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        placeholder={t("search.placeholder")}
        placeholderTextColor={c.muted}
        aria-label={t("search.label")}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        inputMode="search"
        enterKeyHint="search"
        testID="search-input"
        style={[
          type.body,
          styles.input,
          compact && styles.inputCompact,
          {
            color: c.text,
            fontSize: fs(compact ? fontSize.md : fontSize.md + 1),
          },
        ]}
      />
      {value.length > 0 && (
        <Pressable
          role="button"
          aria-label={t("search.clear")}
          onPress={() => onChange("")}
          hitSlop={8}
          style={[styles.clear, { backgroundColor: c.tint }]}
        >
          <Icon name="close" color={c.text} size={18} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    minHeight: 60,
    paddingLeft: space.md + 2,
    paddingRight: space.sm,
    borderWidth: 2,
    borderRadius: radius.lg - 4,
  },
  // The border and the 44 px clear button.
  fieldCompact: {
    minHeight: brand.minTapTarget + space.xs,
    paddingLeft: space.sm + space.xs,
    paddingRight: 0,
    borderRadius: radius.md,
  },
  input: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    paddingVertical: space.sm,
    borderWidth: 0,
  },
  inputCompact: { paddingVertical: space.xs },
  clear: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
