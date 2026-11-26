import { Pressable, StyleSheet, Text, View } from "react-native";
import { i18n, t, tn } from "../i18n";
import { present } from "../lib/present";
import type { LocationSummary } from "../lib/types";
import {
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  useWide,
} from "../theme";
import { Button } from "./Controls";
import { Icon, StatusGlyph } from "./Icon";
import { PowerTile } from "./PowerTile";

const p = present(i18n);

/** One place in the list: power tile, name, availability, distance and price. */
export function PlaceRow({
  place,
  selected,
  onPress,
  showAddress = false,
}: {
  place: LocationSummary;
  selected: boolean;
  onPress: () => void;
  /** The street and city under the name, to tell places at one spot apart. */
  showAddress?: boolean;
}) {
  const { c, scheme } = useTheme();
  const { fs } = useScale();
  const compact = !useWide();
  const avail = p.availability(place);
  const closed = p.closedNote(place);
  const price = p.lead(place.price);
  const distance =
    place.distance_m !== undefined ? i18n.distance(place.distance_m) : "";
  // A closed place keeps its free count, but not in the green that invites a driver.
  const statusColor = closed
    ? c.muted
    : avail.kind === "free"
      ? c.free
      : avail.kind === "busy"
        ? c.busy
        : avail.kind === "down"
          ? c.danger
          : c.muted;
  return (
    <Pressable
      // No aria-label: the row's name is its own text (power, name, status, distance,
      // price), so the words a driver sees are the ones voice control and screen
      // readers use (WCAG 2.5.3).
      role="button"
      aria-current={selected ? "true" : undefined}
      onPress={onPress}
      testID={`place-${place.name}`}
      style={({ pressed }) => [
        styles.row,
        compact && styles.rowCompact,
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
      <PowerTile
        kw={place.max_power_kw}
        kind={avail.kind}
        closed={closed !== undefined}
        announce
        compact={compact}
        size={compact ? 46 : undefined}
      />
      <View style={[styles.middle, compact && styles.middleCompact]}>
        <Text
          style={[
            type.strong,
            {
              color: c.text,
              fontSize: fs(compact ? fontSize.md : fontSize.md + 1),
            },
          ]}
          numberOfLines={2}
        >
          {place.name}
        </Text>
        {showAddress ? (
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
            numberOfLines={2}
            testID="place-address"
          >
            {[place.address, place.city].join(", ")}
          </Text>
        ) : null}
        <View style={[styles.meta, compact && styles.metaCompact]}>
          <StatusGlyph kind={avail.kind} color={statusColor} />
          <Text
            style={[
              compact ? type.body : type.strong,
              { color: statusColor, fontSize: fs(fontSize.sm) },
            ]}
          >
            {avail.text}
          </Text>
          {closed ? (
            <View style={styles.closed} testID="place-closed-now">
              <Icon name="clock" color={c.text} size={14} />
              <Text
                style={[
                  type.strong,
                  { color: c.text, fontSize: fs(fontSize.sm) },
                ]}
              >
                {closed}
              </Text>
            </View>
          ) : null}
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
            {
              color: c.text,
              fontSize: fs(compact ? fontSize.md : fontSize.md + 1),
            },
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
  const compact = !useWide();
  const headSize = fs(compact ? fontSize.sm : fontSize.smd);
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
    <View style={[styles.list, compact && styles.listCompact]}>
      <View style={styles.head}>
        <Text
          role="status"
          style={[type.body, { color: c.muted, fontSize: headSize }]}
          testID="result-count"
        >
          <Text style={[type.strong, { color: c.text }]}>
            {tn("results.places", items.length)}
          </Text>
          {nearRadiusM
            ? ` ${t("results.within", { distance: i18n.distance(nearRadiusM) })}`
            : ""}
        </Text>
        <Text style={[type.body, { color: c.muted, fontSize: headSize }]}>
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
  listCompact: { gap: space.xs + 2 },
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
  rowCompact: {
    gap: space.sm + 2,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm + 2,
  },
  pressed: { opacity: 0.9 },
  middle: { flex: 1, minWidth: 0, gap: space.xs },
  middleCompact: { gap: 2 },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.xs + 2,
  },
  metaCompact: { rowGap: 0 },
  closed: { flexDirection: "row", alignItems: "center", gap: space.xs + 2 },
  price: { alignItems: "flex-end", maxWidth: "38%" },
  note: { padding: space.md },
  empty: {
    gap: space.sm + 4,
    padding: space.lg,
    borderRadius: radius.lg - 4,
    alignItems: "flex-start",
  },
});
