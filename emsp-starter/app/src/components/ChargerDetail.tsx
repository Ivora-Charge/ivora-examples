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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { i18n, t } from "../i18n";
import { ApiError, getFavourites, getLocation, setFavourite } from "../lib/api";
import { directionsUrl } from "../lib/directions";
import type { OpenState } from "../lib/hours";
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
  useWide,
  type Palette,
} from "../theme";
import { useAuth } from "./AuthProvider";
import { Button, Section } from "./Controls";
import { canAddCard } from "./AddCard";
import { Icon, StatusGlyph } from "./Icon";
import { CardBeforeSignIn } from "./PhoneApp";

const p = present(i18n);

/** The least height the card keeps for its details above pinned buttons. */
const CARD_MIN_DETAILS = 120;

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
 * beside the map on wide screens, a full page on phones. Directions and the charge
 * action are pinned under the scrolling details, in the card and on a phone's page,
 * while there is room for both; "Report a problem" ends the details. Signed out on the
 * web, the buttons come with the words that a charge needs a card saved in the phone
 * app (see `cardNote`).
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
  const { fs, dim } = useScale();
  const wide = useWide();
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [favourite, setFav] = useState<boolean | null>(null);
  // Measured, to know whether pinned buttons leave the details enough room.
  const [frameHeight, setFrameHeight] = useState(0);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [buttonsHeight, setButtonsHeight] = useState(0);
  const [noteHeight, setNoteHeight] = useState(0);
  const token = auth.token;

  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
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

  // Whether this place is one of the driver's favourites (signed in only).
  useEffect(() => {
    setFav(null);
    if (!token) return;
    let live = true;
    getFavourites(token).then(
      (list) => live && setFav(list.some((f) => f.locationId === id)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [id, token]);

  const toggleFavourite = async () => {
    if (!token || favourite === null) return;
    const next = !favourite;
    setFav(next);
    try {
      await setFavourite(token, id, next);
    } catch {
      setFav(!next);
    }
  };

  const place = load.state === "ready" ? load.location : summary;
  const distance =
    summary?.distance_m !== undefined
      ? i18n.distance(summary.distance_m)
      : undefined;
  const lang = i18n.locale.split("-")[0];
  // The card sits under the map screen's own heading; the page is a screen.
  const sectionLevel = variant === "card" ? 3 : 2;
  const text = (list?: { language: string; text: string }[]) =>
    (list?.find((d) => d.language === lang) ?? list?.[0])?.text;

  const header = (
    <View
      style={[styles.header, { backgroundColor: c.primary }]}
      // Web: focus rings in here use `focusOnPrimary` (see WebStyles.web.tsx).
      {...({ dataSet: { onPrimary: "true" } } as object)}
      onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
    >
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
        {favourite !== null && (
          <View style={[styles.close, { backgroundColor: `${c.onPrimary}26` }]}>
            <Pressable
              role="switch"
              aria-checked={favourite}
              aria-label={t("favourites.toggle")}
              onPress={() => void toggleFavourite()}
              style={styles.closeHit}
              testID="favourite-toggle"
            >
              <Icon name="star" color={c.onPrimary} filled={favourite} />
            </Pressable>
          </View>
        )}
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
        // The card sits under the map screen's own heading; the page is a screen.
        aria-level={variant === "card" ? 2 : 1}
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
          {[p.address(place), p.parking(place.parking_type)]
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
    const hours = p.hours(l);
    const directions = text(l.directions);
    body = (
      <View>
        <Section level={sectionLevel} title={t("detail.price")} first>
          {price ? (
            <View style={styles.gapSm} testID="detail-price">
              <Text
                style={[
                  type.heading,
                  { color: c.text, fontSize: fs(fontSize.xl) },
                ]}
                testID="detail-price-now"
              >
                {price.amount}
              </Text>
              {price.tiers.map((line) => (
                // A rate that applies instead at some power: as plain as the line above.
                <Text
                  key={line}
                  style={[
                    type.heading,
                    { color: c.text, fontSize: fs(fontSize.lg) },
                  ]}
                  testID="detail-price-tier"
                >
                  {line}
                </Text>
              ))}
              {price.session ? (
                <Text
                  style={[
                    type.strong,
                    { color: c.text, fontSize: fs(fontSize.md) },
                  ]}
                >
                  {price.session}
                </Text>
              ) : null}
              {[...price.conditions, price.min, price.max, price.vat]
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
              {price.others.length > 0 && (
                <View style={styles.otherPrices} testID="detail-price-others">
                  <Text
                    role="heading"
                    aria-level={sectionLevel + 1}
                    style={[
                      type.strong,
                      { color: c.text, fontSize: fs(fontSize.sm + 1) },
                    ]}
                  >
                    {t("price.others")}
                  </Text>
                  {price.others.map((line) => (
                    <Text
                      key={line}
                      style={[
                        type.body,
                        { color: c.text, fontSize: fs(fontSize.sm + 1) },
                      ]}
                    >
                      {line}
                    </Text>
                  ))}
                </View>
              )}
              {price.unexplained ? (
                <Text
                  style={[
                    type.body,
                    { color: c.text, fontSize: fs(fontSize.sm + 1) },
                  ]}
                  testID="detail-price-unexplained"
                >
                  {price.unexplained}
                </Text>
              ) : null}
              {price.operatorNote ? (
                <Text
                  style={[
                    type.body,
                    { color: c.muted, fontSize: fs(fontSize.sm) },
                  ]}
                  testID="detail-price-note"
                >
                  {price.operatorNote}
                </Text>
              ) : null}
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

        <Section level={sectionLevel} title={t("detail.connectors")}>
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
          level={sectionLevel}
          title={t("detail.hours")}
          aside={
            hours.current ? <OpenNow current={hours.current} /> : undefined
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
          {hours.exceptions.length > 0 && (
            <View style={styles.exceptions} testID="detail-exceptions">
              <Text
                role="heading"
                aria-level={sectionLevel + 1}
                style={[
                  type.strong,
                  { color: c.text, fontSize: fs(fontSize.sm + 1) },
                ]}
              >
                {t("detail.exceptional")}
              </Text>
              {hours.exceptions.map((line) => (
                <Text
                  key={line}
                  style={[
                    type.body,
                    { color: c.text, fontSize: fs(fontSize.md) },
                  ]}
                >
                  {line}
                </Text>
              ))}
            </View>
          )}
          {hours.zoneNote ? (
            <Text
              testID="detail-zone"
              style={[
                type.body,
                styles.zoneNote,
                { color: c.muted, fontSize: fs(fontSize.sm) },
              ]}
            >
              {hours.zoneNote}
            </Text>
          ) : null}
        </Section>

        {directions ? (
          <Section level={sectionLevel} title={t("detail.gettingThere")}>
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

  // Side by side while each has room for its label in two lines at most; stacked when
  // the card or the screen is narrower than that, or the driver's text is larger.
  const buttons = place && (
    <View
      style={styles.actions}
      onLayout={(e) => setButtonsHeight(e.nativeEvent.layout.height)}
    >
      <Button
        label={t("detail.directions")}
        icon="directions"
        variant="secondary"
        onPress={() =>
          void Linking.openURL(
            directionsUrl(place.coordinates, place.name, Platform.OS),
          )
        }
        style={[styles.action, { flexBasis: dim(144) }]}
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
            ? router.push(`/charge/${id}`)
            : router.push("/account")
        }
        style={[styles.action, styles.primaryAction, { flexBasis: dim(168) }]}
        testID="charge"
      />
    </View>
  );

  const report = place && auth.state === "signedIn" && (
    <Pressable
      role="link"
      aria-label={t("report.open")}
      onPress={() =>
        router.push({ pathname: "/report", params: { location: id } })
      }
      style={styles.link}
      testID="detail-report"
    >
      <Icon name="flag" color={c.text} size={18} />
      <Text
        style={[
          type.strong,
          styles.underline,
          { color: c.text, fontSize: fs(fontSize.sm + 1) },
        ]}
      >
        {t("report.open")}
      </Text>
    </Pressable>
  );

  // Where pinning the buttons would crowd the details (a short window, very large
  // text), they end the details instead. A phone's page gives them a third of its
  // height at most. The card keeps a minimum for the details between its header and
  // the buttons; short of that, the header scrolls with the details too.
  const footerBottom =
    variant === "card" ? space.lg : Math.max(insets.bottom, space.md);
  const footerHeight = space.md + buttonsHeight + footerBottom;
  const pinned =
    variant === "card"
      ? frameHeight === 0 ||
        frameHeight - headerHeight - footerHeight >= CARD_MIN_DETAILS
      : !wide && (frameHeight === 0 || footerHeight <= frameHeight / 3);
  // What a signed-out web driver should read before "Sign in to charge". It sits right
  // above the buttons. Where the pinned footer would then take more than a third of the
  // height, or leave a card's details under their minimum, it opens the details
  // instead: still seen on arrival, with the buttons still pinned.
  const cardNote = !canAddCard && place && auth.state === "signedOut" && (
    <View
      style={styles.cardNote}
      onLayout={(e) => setNoteHeight(e.nativeEvent.layout.height)}
    >
      <CardBeforeSignIn />
    </View>
  );
  const noteFits =
    frameHeight === 0 ||
    (footerHeight + noteHeight <= frameHeight / 3 &&
      (variant === "page" ||
        frameHeight - headerHeight - footerHeight - noteHeight >=
          CARD_MIN_DETAILS));
  const details = (
    <>
      {pinned && !noteFits && cardNote}
      {body}
      {!pinned && (
        <View style={styles.inlineActions}>
          {cardNote}
          {buttons}
        </View>
      )}
      {report && <View style={styles.report}>{report}</View>}
    </>
  );
  const footer = pinned && buttons && (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          paddingBottom: footerBottom,
        },
      ]}
      testID="detail-footer"
    >
      {noteFits && cardNote}
      {buttons}
    </View>
  );

  if (variant === "page")
    return (
      <View
        role="main"
        style={[styles.flex, { backgroundColor: c.background }]}
        onLayout={(e) => setFrameHeight(e.nativeEvent.layout.height)}
      >
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.pageContent}
        >
          {header}
          <View
            style={[
              styles.body,
              styles.pageBody,
              { backgroundColor: c.surface },
            ]}
          >
            {details}
          </View>
        </ScrollView>
        {footer}
      </View>
    );
  return (
    <View
      role="region"
      aria-label={place?.name ?? t("detail.title")}
      style={[styles.card, { backgroundColor: c.surface }]}
      onLayout={(e) => setFrameHeight(e.nativeEvent.layout.height)}
      testID="detail-card"
    >
      {pinned && header}
      <ScrollView style={styles.flex}>
        {!pinned && header}
        <View style={styles.body}>{details}</View>
      </ScrollView>
      {footer}
    </View>
  );
}

/**
 * Open or closed right now. A closed site where charging is still possible is told
 * neutrally, with a clock in the text colour: nothing is wrong for the driver.
 */
function OpenNow({
  current,
}: {
  current: { state: OpenState; label: string };
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const color =
    current.state === "open"
      ? c.free
      : current.state === "closed"
        ? c.danger
        : c.text;
  return (
    <View style={[styles.status, styles.shrink]} testID="detail-open-now">
      {current.state === "closedCanCharge" ? (
        <Icon name="clock" color={color} size={16} />
      ) : (
        <StatusGlyph
          kind={current.state === "open" ? "free" : "down"}
          color={color}
        />
      )}
      <Text
        style={[
          type.strong,
          styles.shrink,
          { color, fontSize: fs(fontSize.sm) },
        ]}
      >
        {current.label}
      </Text>
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
  gap: { gap: space.md },
  gapSm: { gap: space.sm },
  exceptions: { paddingTop: space.md, gap: space.xs },
  zoneNote: { paddingTop: space.sm },
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
  otherPrices: { paddingTop: space.xs, gap: space.xs },
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
  shrink: { flexShrink: 1 },
  actions: { flexDirection: "row", gap: space.sm + 4, flexWrap: "wrap" },
  action: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: space.md,
  },
  primaryAction: { flexGrow: 1.4 },
  link: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: space.xs + 2,
    minHeight: 44,
  },
  underline: { textDecorationLine: "underline" },
  card: { flex: 1, borderRadius: radius.lg + 6, overflow: "hidden" },
  pageContent: { flexGrow: 1 },
  pageBody: { flexGrow: 1 },
  inlineActions: { paddingTop: space.lg },
  // Padding, not margin: the measured height includes the gap to what follows.
  cardNote: { paddingBottom: space.sm },
  report: { paddingTop: space.md },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
  },
});
