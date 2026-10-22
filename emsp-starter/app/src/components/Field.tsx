import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";

/** A labelled text input, 56 px or taller, with a 2 px ink outline like sign-in's. */
export function Field({
  id,
  label,
  hint,
  multiline = false,
  mono = false,
  ...input
}: {
  /** Unique on the screen: ties the label to the input. */
  id: string;
  label: string;
  hint?: string;
  mono?: boolean;
} & Omit<TextInputProps, "style">) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View style={styles.field}>
      <Text
        nativeID={`${id}-label`}
        style={[type.strong, { color: c.text, fontSize: fs(fontSize.sm + 1) }]}
      >
        {label}
      </Text>
      <TextInput
        aria-labelledby={`${id}-label`}
        aria-label={label}
        placeholderTextColor={c.muted}
        multiline={multiline}
        {...input}
        style={[
          mono ? type.mono : type.body,
          styles.input,
          multiline && styles.multiline,
          {
            color: c.text,
            borderColor: c.text,
            backgroundColor: c.surface,
            fontSize: fs(fontSize.md + 1),
          },
        ]}
      />
      {hint ? (
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space.xs + 2 },
  input: {
    minHeight: 56,
    paddingHorizontal: space.md,
    borderWidth: 2,
    borderRadius: radius.md,
  },
  multiline: {
    minHeight: 120,
    paddingVertical: space.sm + 4,
    textAlignVertical: "top",
  },
});
