import { router } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { IconButton } from "./Controls";
import { Icon, type IconName } from "./Icon";

/** A screen of its own: a back button, the title (the screen's one h1) and its parts. */
export function Page({
  title,
  children,
  back = true,
  testID,
}: {
  title: string;
  children: ReactNode;
  /** A back button before the title (pages opened from a tab). */
  back?: boolean;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <ScrollView
      role="main"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      testID={testID}
    >
      <View style={styles.head}>
        {back && (
          <IconButton
            icon="back"
            label={t("common.back")}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace("/charging")
            }
            testID="page-back"
          />
        )}
        <Text
          role="heading"
          aria-level={1}
          style={[
            type.heading,
            styles.flex,
            { color: c.text, fontSize: fs(fontSize.xxl) },
          ]}
        >
          {title}
        </Text>
      </View>
      {children}
    </ScrollView>
  );
}

/** A white card on the page, with an optional heading one level below the page's. */
export function Card({
  title,
  icon,
  children,
  testID,
}: {
  title?: string;
  icon?: IconName;
  children: ReactNode;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View style={[styles.card, { backgroundColor: c.surface }]} testID={testID}>
      {title && (
        <View style={styles.cardHead}>
          {icon && (
            <View style={[styles.icon, { backgroundColor: c.tint }]}>
              <Icon name={icon} color={c.primary} />
            </View>
          )}
          <Text
            role="heading"
            aria-level={2}
            style={[
              type.heading,
              styles.flex,
              { color: c.text, fontSize: fs(fontSize.lg) },
            ]}
          >
            {title}
          </Text>
        </View>
      )}
      {children}
    </View>
  );
}

/**
 * A message in the flow of the page: `error` and `warning` are read out at once
 * (alert), `info` and `success` politely (status). The words say what happened; the
 * colour only repeats it.
 */
export function Notice({
  kind,
  title,
  children,
  testID,
}: {
  kind: "info" | "success" | "warning" | "error";
  title?: string;
  children?: ReactNode;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const edge =
    kind === "error"
      ? c.danger
      : kind === "warning"
        ? c.busy
        : kind === "success"
          ? c.free
          : c.primary;
  return (
    <View
      role={kind === "error" || kind === "warning" ? "alert" : "status"}
      style={[
        styles.notice,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          borderLeftColor: edge,
        },
      ]}
      testID={testID}
    >
      {title && (
        <Text
          style={[type.strong, { color: c.text, fontSize: fs(fontSize.md) }]}
        >
          {title}
        </Text>
      )}
      {typeof children === "string" ? (
        <Text
          style={[type.body, { color: c.text, fontSize: fs(fontSize.sm + 1) }]}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

/** A label and its value, in a row that wraps on narrow screens. */
export function Fact({
  label,
  value,
  strong = false,
  testID,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  return (
    <View
      style={[styles.fact, { borderBottomColor: c.border }]}
      testID={testID}
    >
      <Text
        style={[
          type.body,
          styles.flex,
          { color: c.muted, fontSize: fs(fontSize.sm + 1) },
        ]}
      >
        {label}
      </Text>
      <Text
        style={[
          strong ? type.strong : type.body,
          styles.value,
          {
            color: c.text,
            fontSize: fs(strong ? fontSize.md + 1 : fontSize.md),
          },
        ]}
      >
        {value}
      </Text>
    </View>
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
  head: { flexDirection: "row", alignItems: "center", gap: space.sm + 4 },
  flex: { flex: 1, minWidth: 0 },
  card: { padding: space.lg, gap: space.sm + 4, borderRadius: radius.lg },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm + 4 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    padding: space.md,
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderLeftWidth: 6,
  },
  fact: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
  },
  value: { flexShrink: 1, textAlign: "right" },
});
