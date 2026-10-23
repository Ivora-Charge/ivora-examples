import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { AddCard } from "../../components/AddCard";
import { useAuth } from "../../components/AuthProvider";
import { HistoryList } from "../../components/ChargeLists";
import { Choice, ChoiceGroup } from "../../components/Choice";
import { Button } from "../../components/Controls";
import { Card, Notice } from "../../components/Page";
import { t } from "../../i18n";
import {
  ApiError,
  getCards,
  getHistory,
  removeCard,
  setDefaultCard,
} from "../../lib/api";
import { cardExpiry, cardLabel } from "../../lib/charge-words";
import type { Card as SavedCard, HistoryItem } from "../../lib/charging";
import { DEMO_DECLINE_CARD_ID } from "../../lib/demo-charge";
import { fontSize, radius, space, type, useScale, useTheme } from "../../theme";

/**
 * The Wallet tab: the driver's saved cards (Stripe holds them; the app sees the brand,
 * the last 4 digits and the expiry), which one pays, adding and removing cards, and the
 * receipts of past charges.
 */
export default function Wallet() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const token = auth.token;
  const [cards, setCards] = useState<SavedCard[] | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [message, setMessage] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [list, items] = await Promise.all([
        getCards(token),
        getHistory(token),
      ]);
      setCards(list);
      setHistory(items);
    } catch {
      setMessage({ kind: "error", text: t("wallet.loadError") });
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(id);
    setMessage(null);
    try {
      await fn();
      setMessage({ kind: "success", text: done });
      await load();
    } catch (e) {
      setMessage({
        kind: "error",
        text:
          e instanceof ApiError && e.code === "demo_mode"
            ? t("wallet.demoRemove")
            : e instanceof ApiError && e.code === "unreachable"
              ? t("common.unreachable")
              : t("wallet.actionFailed"),
      });
    } finally {
      setBusy(null);
    }
  };

  const heading = (
    <Text
      role="heading"
      aria-level={1}
      style={[type.heading, { color: c.text, fontSize: fs(fontSize.xxl) }]}
    >
      {t("wallet.title")}
    </Text>
  );

  if (auth.state !== "signedIn" || !token)
    return (
      <ScrollView
        role="main"
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.page}
      >
        {heading}
        <View style={[styles.card, { backgroundColor: c.surface }]}>
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("wallet.signIn")}
          </Text>
          <Button
            label={t("wallet.signInButton")}
            onPress={() => router.navigate("/account")}
          />
        </View>
      </ScrollView>
    );

  const demo = auth.driver.mode === "demo";
  return (
    <ScrollView
      role="main"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
    >
      {heading}
      {message && (
        <Notice kind={message.kind} testID="wallet-message">
          {message.text}
        </Notice>
      )}
      <Card title={t("wallet.cards")} icon="card" testID="wallet-cards">
        {cards === null ? (
          <Text
            role="status"
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("common.loading")}
          </Text>
        ) : cards.length ? (
          <ChoiceGroup label={t("wallet.payWith")}>
            {cards.map((card) => (
              <View key={card.id} style={styles.cardRow}>
                <Choice
                  label={cardLabel(card)}
                  detail={[
                    card.isDefault ? t("wallet.default") : "",
                    cardExpiry(card),
                    card.id === DEMO_DECLINE_CARD_ID && demo
                      ? t("wallet.demoDecline")
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  selected={card.isDefault}
                  onPress={() =>
                    void act(
                      card.id,
                      () => setDefaultCard(token, card.id),
                      t("wallet.defaultSet", { card: cardLabel(card) }),
                    )
                  }
                  testID={`card-${card.last4}`}
                />
                <Button
                  label={t("wallet.remove", { card: cardLabel(card) })}
                  variant="secondary"
                  busy={busy === card.id}
                  onPress={() =>
                    void act(
                      card.id,
                      () => removeCard(token, card.id),
                      t("wallet.removed", { card: cardLabel(card) }),
                    )
                  }
                  testID={`remove-${card.last4}`}
                />
              </View>
            ))}
          </ChoiceGroup>
        ) : (
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("wallet.noCards")}
          </Text>
        )}
        <AddCard
          token={token}
          onDone={(outcome) => {
            setMessage(
              outcome === "demo"
                ? { kind: "info", text: t("wallet.demoAdd") }
                : { kind: "success", text: t("wallet.added") },
            );
            void load();
          }}
          onError={(text) => setMessage({ kind: "error", text })}
        />
        <Text
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.sm) }]}
        >
          {demo ? t("wallet.demoNote") : t("wallet.stripeNote")}
        </Text>
      </Card>

      <Card
        title={t("wallet.receipts")}
        icon="receipt"
        testID="wallet-receipts"
      >
        {history.some((i) => i.receipt) ? (
          <HistoryList
            items={history}
            receiptsOnly
            label={t("wallet.receipts")}
          />
        ) : (
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("wallet.noReceipts")}
          </Text>
        )}
      </Card>
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
  card: { padding: space.lg, gap: space.sm + 4, borderRadius: radius.lg },
  cardRow: { gap: space.sm },
});
