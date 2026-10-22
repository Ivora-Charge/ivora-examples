import { router } from "expo-router";
import { useEffect, useState } from "react";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { i18n, t } from "../i18n";
import { ApiError, getLocation } from "../lib/api";
import { directionsUrl } from "../lib/directions";
import { present } from "../lib/present";
import { evseKind, type StatusKind } from "../lib/status";
import type { LocationDetail, LocationSummary } from "../lib/types";
import {
  fontSize,
  radius,
  space,
  type,
  useScale,
  useTheme,
  type Palette,
} from "../theme";
import { useAuth } from "./AuthProvider";
import { Button, Section } from "./Controls";
import { Icon, StatusGlyph } from "./Icon";

const p = present(i18n);

const statusColor = (kind: StatusKind, c: Palette) =>
  kind === "free"
    ? c.free
    : kind === "busy"
      ? c.busy
      : kind === "down"
        ? c.danger
        : c.muted;

type Load =
  | { state: "loading" }
  | { state: "error"; notFound: boolean }
  | { state: "ready"; location: LocationDetail };

/**
 * A charger's page: where it is, its price from the tariff, its connectors with EVSE
 * IDs and status, opening hours, directions, and the way to charge. A floating card
 * beside the map on wide screens, a full page on phones.
 */
export function ChargerDetail({
  id,
  summary,
  variant,
  onClose,
}: {
  id: string;
  /** What the list already knows, shown while the rest loads. */
  summary?: LocationSummary;
  variant: "card" | "page";
  onClose: () => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [chargeNote, setChargeNote] = useState(false);

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    setChargeNote(false);
    getLocation(id).then(
      (location) => live && setLoad({ state: "ready", location }),
      (e: unknown) =>
        live &&
        setLoad({
          state: "error",
          notFound: e instanceof ApiError && e.code === "not_found",
        }),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const place = load.state === "ready" ? load.location : summary;
  const distance =
    summary?.distance_m !== undefined
      ? i18n.distance(summary.distance_m)
      : undefined;
  const lang = i18n.locale.split("-")[0];
  const text = (list?: { language: string; text: string }[]) =>
    (list?.find((d) => d.language === lang) ?? list?.[0])?.text;

  const header = (
    <View style={[styles.header, { backgroundColor: c.primary }]}>
      <View style={styles.headerTop}>
        <Text
          style={[
            type.strong,
            styles.flex,
            { color: c.onPrimary, fontSize: fs(fontSize.sm) },
          ]}
        >
          {[place?.operator, distance].filter(Boolean).join(" · ")}
        </Text>
        <View style={[styles.close, { backgroundColor: `${c.onPrimary}26` }]}>
          <HeaderButton
            icon={variant === "card" ? "close" : "back"}
            label={variant === "card" ? t("detail.close") : t("detail.back")}
            onPress={onClose}
            color={c.onPrimary}
          />
        </View>
      </View>
      <Text
        role="heading"
        aria-level={1}
        style={[
          type.heading,
          styles.name,
          { color: c.onPrimary, fontSize: fs(fontSize.xl + 4) },
        ]}
        testID="detail-name"
      >
        {place?.name ?? t("detail.title")}
      </Text>
      {place && (
        <Text
          style={[
            type.body,
            { color: c.onPrimary, fontSize: fs(fontSize.sm + 1) },
          ]}
        >
          {[
            [place.address, place.city].join(", "),
            p.parking(place.parking_type),
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
    </View>
  );

  let body;
  if (load.state === "loading")
    body = (
      <Text
        role="status"
        style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
      >
        {t("detail.loading")}
      </Text>
    );
  else if (load.state === "error")
    body = (
      <View style={styles.gap} role="alert">
        <Text
          style={[type.strong, { color: c.text, fontSize: fs(fontSize.md) }]}
        >
          {load.notFound ? t("detail.notFound") : t("detail.error")}
        </Text>
        {!load.notFound && (
          <Button
            label={t("results.retry")}
            variant="secondary"
            onPress={() => setAttempt((n) => n + 1)}
          />
        )}
      </View>
    );
  else {
    const l = load.location;
    const priced = l.evses
      .flatMap((e) => e.connectors)
      .find((x) => x.price)?.price;
    const price = priced ? p.detailPrice(priced) : undefined;
    const hours = p.hours(l.opening_times, l.time_zone);
    const directions = text(l.directions);
    body = (
      <View>
        <Section title={t("detail.price")} first>
          {price ? (
            <View style={styles.gapSm} testID="detail-price">
              <View style={styles.priceRow}>
                <Text
                  style={[
                    type.heading,
                    { color: c.text, fontSize: fs(fontSize.xxl) },
                  ]}
                >
                  {price.amount}
                </Text>
                {price.unit ? (
                  <Text
                    style={[
                      type.body,
                      { color: c.muted, fontSize: fs(fontSize.md) },
                    ]}
                  >
                    {[price.unit, price.vat].filter(Boolean).join(", ")}
                  </Text>
                ) : null}
              </View>
              {price.conditions.length > 0 && (
                <Text
                  style={[
                    type.body,
                    { color: c.muted, fontSize: fs(fontSize.sm) },
                  ]}
                >
                  {price.conditions.join(", ")}
                </Text>
              )}
              {price.more.map((m) => (
                <Text
                  key={m}
                  style={[
                    type.body,
                    { color: c.text, fontSize: fs(fontSize.sm + 1) },
                  ]}
                >
                  {m}
                </Text>
              ))}
              {[
                priced?.minPrice && t("price.min", { amount: priced.minPrice }),
                priced?.maxPrice && t("price.max", { amount: priced.maxPrice }),
                priced?.altText,
              ]
                .filter(Boolean)
                .map((s) => (
                  <Text
                    key={s}
                    style={[
                      type.body,
                      { color: c.muted, fontSize: fs(fontSize.sm) },
                    ]}
                  >
                    {s}
                  </Text>
                ))}
              <Text
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.sm) },
                ]}
              >
                {t("price.displayOnly")}
              </Text>
            </View>
          ) : (
            <Text
              style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
            >
              {t("price.unknown")}
            </Text>
          )}
        </Section>

        <Section title={t("detail.connectors")}>
          <View role="list">
            {l.evses.flatMap((e) =>
              e.connectors.map((x) => {
                const kind = evseKind(e.status);
                const col = statusColor(kind, c);
                const standard = p.connector(x.standard);
                const power = i18n.kw(x.max_power_kw);
                return (
                  <View
                    key={`${e.uid}/${x.id}`}
                    role="listitem"
                    aria-label={t("detail.connectorA11y", {
                      standard,
                      power,
                      status: p.status(kind),
                      id: e.evse_id ?? e.uid,
                    })}
                    style={[styles.connector, { borderBottomColor: c.border }]}
                    testID="connector"
                  >
                    <View style={[styles.plug, { backgroundColor: c.tint }]}>
                      <Icon name="plug" color={c.primary} size={20} />
                    </View>
                    <View style={styles.flex}>
                      <Text
                        style={[
                          type.strong,
                          { color: c.text, fontSize: fs(fontSize.md) },
                        ]}
                      >
                        {t("detail.connector", { standard, power })}
                      </Text>
                      <Text
                        style={[
                          type.mono,
                          { color: c.muted, fontSize: fs(fontSize.xs + 1) },
                        ]}
                        selectable
                      >
                        {[
                          e.evse_id ?? e.uid,
                          e.physical_reference &&
                            t("detail.reference", {
                              reference: e.physical_reference,
                            }),
                          e.floor_level &&
                            t("detail.floor", { floor: e.floor_level }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                    <View style={styles.status}>
                      <StatusGlyph kind={kind} color={col} />
                      <Text
                        style={[
                          type.strong,
                          { color: col, fontSize: fs(fontSize.sm) },
                        ]}
                      >
                        {p.status(kind)}
                      </Text>
                    </View>
                  </View>
                );
              }),
            )}
          </View>
        </Section>

        <Section
          title={t("detail.hours")}
          aside={
            hours.open !== undefined ? (
              <View style={styles.status}>
                <StatusGlyph
                  kind={hours.open ? "free" : "down"}
                  color={hours.open ? c.free : c.danger}
                />
                <Text
                  style={[
                    type.strong,
                    {
                      color: hours.open ? c.free : c.danger,
                      fontSize: fs(fontSize.sm),
                    },
                  ]}
                >
                  {hours.open ? t("detail.openNow") : t("detail.closedNow")}
                </Text>
              </View>
            ) : undefined
          }
        >
          {hours.lines.map((line) => (
            <Text
              key={line}
              style={[type.body, { color: c.text, fontSize: fs(fontSize.md) }]}
            >
              {line}
            </Text>
          ))}
        </Section>

        {directions ? (
          <Section title={t("detail.gettingThere")}>
            <Text
              style={[type.body, { color: c.text, fontSize: fs(fontSize.md) }]}
            >
              {directions}
            </Text>
          </Section>
        ) : null}
      </View>
    );
  }

  const actions = place && (
    <View style={styles.gapSm}>
      {chargeNote && (
        <Text
          role="alert"
          style={[type.body, { color: c.text, fontSize: fs(fontSize.sm + 1) }]}
        >
          {t("detail.chargeSoon")}
        </Text>
      )}
      <View style={styles.actions}>
        <Button
          label={t("detail.directions")}
          icon="directions"
          variant="secondary"
          onPress={() =>
            void Linking.openURL(
              directionsUrl(place.coordinates, place.name, Platform.OS),
            )
          }
          style={styles.flex}
          testID="directions"
        />
        <Button
          label={
            auth.state === "signedIn"
              ? t("detail.chargeHere")
              : t("detail.signInToCharge")
          }
          icon="bolt"
          onPress={() =>
            auth.state === "signedIn"
              ? setChargeNote(true)
              : router.push("/account")
          }
          style={styles.grow}
          testID="charge"
        />
      </View>
    </View>
  );

  if (variant === "page")
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.pageContent}
      >
        {header}
        <View style={[styles.body, { backgroundColor: c.surface }]}>
          {body}
          <View style={styles.pageActions}>{actions}</View>
        </View>
      </ScrollView>
    );
  return (
    <View
      style={[styles.card, { backgroundColor: c.surface }]}
      testID="detail-card"
    >
      {header}
      <ScrollView style={styles.flex} contentContainerStyle={styles.body}>
        {body}
      </ScrollView>
      <View style={[styles.cardActions, { borderTopColor: c.border }]}>
        {actions}
      </View>
    </View>
  );
}

/** The header's close or back button, light on the violet header. */
function HeaderButton({
  icon,
  label,
  onPress,
  color,
}: {
  icon: "close" | "back";
  label: string;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      onPress={onPress}
      style={styles.closeHit}
      testID="detail-close"
    >
      <Icon name={icon} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  grow: { flex: 1.4, minWidth: 0 },
  gap: { gap: space.md },
  gapSm: { gap: space.sm },
  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md + 2,
    paddingBottom: space.md + 4,
    gap: space.xs,
  },
  headerTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { letterSpacing: -0.8 },
  close: { borderRadius: radius.pill },
  closeHit: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.lg,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: space.sm,
  },
  connector: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 4,
    paddingVertical: space.sm + 2,
    borderBottomWidth: 1,
  },
  plug: {
    width: 40,
    height: 40,
    borderRadius: radius.sm + 2,
    alignItems: "center",
    justifyContent: "center",
  },
  status: { flexDirection: "row", alignItems: "center", gap: space.xs + 2 },
  actions: { flexDirection: "row", gap: space.sm + 4, flexWrap: "wrap" },
  card: { flex: 1, borderRadius: radius.lg + 6, overflow: "hidden" },
  cardActions: { padding: space.lg, paddingTop: space.md, borderTopWidth: 1 },
  pageContent: { flexGrow: 1 },
  pageActions: { paddingTop: space.lg },
});
