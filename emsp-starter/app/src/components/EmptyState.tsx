import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

/** A tab whose features arrive in a later part: a title, an icon and a plain note. */
export function EmptyState({
  title,
  heading,
  body,
  icon,
  children,
}: {
  title: string;
  heading: string;
  body: string;
  icon: IconName;
  children?: ReactNode;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
    >
      <Text
        role="heading"
        aria-level={1}
        style={[type.heading, { color: c.text, fontSize: fs(fontSize.xxl) }]}
      >
        {title}
      </Text>
      <View style={[styles.card, { backgroundColor: c.surface }]}>
        <View style={[styles.icon, { backgroundColor: c.tint }]}>
          <Icon name={icon} color={c.primary} size={28} />
        </View>
        <Text
          role="heading"
          aria-level={2}
          style={[type.heading, { color: c.text, fontSize: fs(fontSize.lg) }]}
        >
          {heading}
        </Text>
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
        >
          {body}
        </Text>
        {children}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    padding: space.lg,
    gap: space.lg,
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
  },
  card: {
    padding: space.lg,
    gap: space.sm + 4,
    borderRadius: radius.lg,
    alignItems: "flex-start",
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
