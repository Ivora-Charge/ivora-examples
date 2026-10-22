import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { t } from "../i18n";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Icon } from "./Icon";

/** The search box: place, charger or EVSE ID. 60 px, in thumb reach on phones. */
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
  return (
    <View
      style={[
        styles.field,
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
          { color: c.text, fontSize: fs(fontSize.md + 1) },
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
  input: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    paddingVertical: space.sm,
    borderWidth: 0,
  },
  clear: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
