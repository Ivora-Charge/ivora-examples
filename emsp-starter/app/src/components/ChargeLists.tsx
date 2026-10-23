import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { i18n, t } from "../i18n";
import { stopText } from "../lib/charge-words";
import type { Favourite, HistoryItem } from "../lib/charging";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

/** What a past charge shows as its state, in words. */
function stateOf(item: HistoryItem): string {
  if (item.stopCode) return stopText(item.stopCode) ?? "";
  if (item.status !== "succeeded" && !item.session)
    return t("history.didNotStart");
  if (item.receipt)
    return item.payment.status === "released"
      ? t("history.nothingCharged")
      : t("history.receiptReady");
  if (item.session?.open) return t("history.charging");
  return t("history.waitingForBill");
}

/** One row: an icon, two lines and what it costs, the whole row one link. */
function Row({
  icon,
  title,
  detail,
  amount,
  onPress,
  testID,
}: {
  icon: IconName;
  title: string;
  detail: string;
  amount?: string;
  onPress?: () => void;
  testID?: string;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const content = (
    <>
      <View style={[styles.icon, { backgroundColor: c.tint }]}>
        <Icon name={icon} color={c.primary} size={20} />
      </View>
      <View style={styles.flex}>
        <Text
          style={[type.strong, { color: c.text, fontSize: fs(fontSize.md) }]}
        >
          {title}
        </Text>
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
        >
          {detail}
        </Text>
      </View>
      {amount ? (
        <Text
          style={[type.strong, { color: c.text, fontSize: fs(fontSize.md) }]}
        >
          {amount}
        </Text>
      ) : null}
    </>
  );
  return (
    <View
      role="listitem"
      style={[styles.item, { borderBottomColor: c.border }]}
    >
      {onPress ? (
        // Its name is the words it shows, so voice control finds it by them.
        <Pressable
          role="link"
          onPress={onPress}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          testID={testID}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row} testID={testID}>
          {content}
        </View>
      )}
    </View>
  );
}

/** Past charges, newest first. Each one with a receipt opens it. */
export function HistoryList({
  items,
  receiptsOnly = false,
  label,
}: {
  items: HistoryItem[];
  /** Only settled charges: the Wallet's receipts. */
  receiptsOnly?: boolean;
  label: string;
}) {
  const shown = receiptsOnly ? items.filter((i) => i.receipt) : items;
  return (
    <View role="list" aria-label={label}>
      {shown.map((item) => {
        const title = item.place?.name ?? t("history.unknownPlace");
        const when = i18n.dateTime(item.session?.startedAt ?? item.createdAt);
        const detail = [
          when,
          item.session && i18n.kwh(item.session.kwh),
          stateOf(item),
        ]
          .filter(Boolean)
          .join(" · ");
        const amount = item.receipt
          ? i18n.minor(item.payment.charged, item.payment.currency)
          : undefined;
        return (
          <Row
            key={item.chargeId}
            icon={item.receipt ? "receipt" : "bolt"}
            title={title}
            detail={detail}
            amount={amount}
            onPress={
              item.receipt
                ? () => router.push(`/receipt/${item.chargeId}`)
                : undefined
            }
            testID={receiptsOnly ? "receipt-row" : "history-row"}
          />
        );
      })}
    </View>
  );
}

/** The driver's favourite places: each opens the charger's page. */
export function FavouriteList({ items }: { items: Favourite[] }) {
  return (
    <View role="list" aria-label={t("favourites.title")}>
      {items.map((f) => {
        const title = f.place?.name ?? t("favourites.gone");
        const detail = f.place ? `${f.place.address}, ${f.place.city}` : "";
        return (
          <Row
            key={f.locationId}
            icon="star"
            title={title}
            detail={detail}
            onPress={
              f.place
                ? () => router.push(`/location/${f.locationId}`)
                : undefined
            }
            testID="favourite-row"
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { borderBottomWidth: 1 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 4,
    minHeight: 56,
    paddingVertical: space.sm + 2,
  },
  pressed: { opacity: 0.85 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radius.sm + 2,
    alignItems: "center",
    justifyContent: "center",
  },
  flex: { flex: 1, minWidth: 0 },
});
