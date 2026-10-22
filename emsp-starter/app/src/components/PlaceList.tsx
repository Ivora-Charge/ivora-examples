import { Pressable, StyleSheet, Text, View } from "react-native";
import { i18n, t, tn } from "../i18n";
import { present } from "../lib/present";
import type { LocationSummary } from "../lib/types";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Button } from "./Controls";
import { StatusGlyph } from "./Icon";
import { PowerTile } from "./PowerTile";

const p = present(i18n);

/** One place in the list: power tile, name, availability, distance and price. */
export function PlaceRow({
  place,
  selected,
  onPress,
}: {
  place: LocationSummary;
  selected: boolean;
  onPress: () => void;
}) {
  const { c, scheme } = useTheme();
  const { fs } = useScale();
  const avail = p.availability(place);
  const price = p.lead(place.price);
  const distance =
    place.distance_m !== undefined ? i18n.distance(place.distance_m) : "";
  const statusColor =
    avail.kind === "free"
      ? c.free
      : avail.kind === "busy"
        ? c.busy
        : avail.kind === "down"
          ? c.danger
          : c.muted;
  const label = t("place.a11y", {
    name: place.name,
    status: avail.text,
    power: i18n.kw(place.max_power_kw),
    price: [price.amount, price.unit].filter(Boolean).join(" "),
    distance,
  }).trim();
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      onPress={onPress}
      testID={`place-${place.name}`}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: c.surface,
          borderColor: selected
            ? c.primary
            : scheme === "dark"
              ? c.border
              : c.surface,
        },
        selected && { borderLeftWidth: 6 },
        pressed && styles.pressed,
      ]}
    >
      <PowerTile kw={place.max_power_kw} kind={avail.kind} />
      <View style={styles.middle}>
        <Text
          style={[
            type.strong,
            { color: c.text, fontSize: fs(fontSize.md + 1) },
          ]}
          numberOfLines={2}
        >
          {place.name}
        </Text>
        <View style={styles.meta}>
          <StatusGlyph kind={avail.kind} color={statusColor} />
          <Text
            style={[
              type.strong,
              { color: statusColor, fontSize: fs(fontSize.sm) },
            ]}
          >
            {avail.text}
          </Text>
          {distance ? (
            <Text
              style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
            >
              · {distance}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.price}>
        <Text
          style={[
            type.heading,
            { color: c.text, fontSize: fs(fontSize.md + 1) },
          ]}
          numberOfLines={2}
        >
          {price.amount}
        </Text>
        {price.unit ? (
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
          >
            {price.unit}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export type ListState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; items: LocationSummary[]; nearRadiusM?: number };

/** The results: a count, the sort, and the rows, or a loading, empty or error state. */
export function PlaceList({
  list,
  selectedId,
  onSelect,
  onRetry,
  onClearFilters,
}: {
  list: ListState;
  selectedId?: string;
  onSelect: (place: LocationSummary) => void;
  onRetry: () => void;
  onClearFilters: () => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  if (list.state === "loading")
    return (
      <Text
        role="status"
        style={[
          type.body,
          styles.note,
          { color: c.muted, fontSize: fs(fontSize.md) },
        ]}
      >
        {t("results.loading")}
      </Text>
    );
  if (list.state === "error")
    return (
      <View style={styles.empty} role="alert">
        <Text
          style={[type.strong, { color: c.text, fontSize: fs(fontSize.md) }]}
        >
          {t("results.error")}
        </Text>
        <Button
          label={t("results.retry")}
          variant="secondary"
          onPress={onRetry}
        />
      </View>
    );
  const { items, nearRadiusM } = list;
  return (
    <View style={styles.list}>
      <View style={styles.head}>
        <Text
          role="status"
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm + 1) }]}
          testID="result-count"
        >
          <Text style={[type.strong, { color: c.text }]}>
            {tn("results.places", items.length)}
          </Text>
          {nearRadiusM
            ? ` ${t("results.within", { distance: i18n.distance(nearRadiusM) })}`
            : ""}
        </Text>
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm + 1) }]}
        >
          {nearRadiusM ? t("results.nearest") : t("results.byName")}
        </Text>
      </View>
      {items.length === 0 ? (
        <View style={[styles.empty, { backgroundColor: c.surface }]}>
          <Text
            role="heading"
            aria-level={2}
            style={[type.heading, { color: c.text, fontSize: fs(fontSize.lg) }]}
          >
            {t("results.emptyTitle")}
          </Text>
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("results.emptyBody")}
          </Text>
          <Button
            label={t("filters.clear")}
            variant="secondary"
            onPress={onClearFilters}
          />
        </View>
      ) : (
        items.map((place) => (
          <PlaceRow
            key={place.id}
            place={place}
            selected={place.id === selectedId}
            onPress={() => onSelect(place)}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm + 2 },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.sm,
    paddingHorizontal: space.xs,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md - 2,
    padding: space.sm + 4,
    borderRadius: radius.lg - 4,
    borderWidth: 1.5,
  },
  pressed: { opacity: 0.9 },
  middle: { flex: 1, minWidth: 0, gap: space.xs },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.xs + 2,
  },
  price: { alignItems: "flex-end", maxWidth: "38%" },
  note: { padding: space.md },
  empty: {
    gap: space.sm + 4,
    padding: space.lg,
    borderRadius: radius.lg - 4,
    alignItems: "flex-start",
  },
});
