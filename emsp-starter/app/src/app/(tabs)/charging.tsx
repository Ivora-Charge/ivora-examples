import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../components/AuthProvider";
import { FavouriteList, HistoryList } from "../../components/ChargeLists";
import { Button } from "../../components/Controls";
import { LiveCharge } from "../../components/LiveCharge";
import { Card, Notice } from "../../components/Page";
import { t } from "../../i18n";
import { getActiveCharge, getFavourites, getHistory } from "../../lib/api";
import type { Charge, Favourite, HistoryItem } from "../../lib/charging";
import { onPushOpened } from "../../lib/push";
import { fontSize, radius, space, type, useScale, useTheme } from "../../theme";

/**
 * The Charging tab: the charge in progress, live; otherwise the ways to start one (scan
 * or type a charger's ID, a favourite, the map) and the driver's recent charges.
 */
export default function Charging() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const token = auth.token;
  const [charge, setCharge] = useState<Charge | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [favourites, setFavourites] = useState<Favourite[]>([]);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [active, items, favs] = await Promise.all([
        getActiveCharge(token),
        getHistory(token),
        getFavourites(token),
      ]);
      // Keep a finished charge on screen until the driver closes it.
      setCharge(
        (held) => active ?? (held && !held.command.pending ? held : null),
      );
      setHistory(items);
      setFavourites(favs);
      setError(false);
    } catch {
      setError(true);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A tapped notification opens this tab (or the receipt, from a finished charge).
  useEffect(
    () =>
      onPushOpened((data) => {
        if (data.kind === "charging_done" && data.chargeId)
          router.push(`/receipt/${data.chargeId}`);
        else router.navigate("/charging");
      }),
    [],
  );

  const title = (
    <Text
      role="heading"
      aria-level={1}
      style={[type.heading, { color: c.text, fontSize: fs(fontSize.xxl) }]}
    >
      {t("charging.title")}
    </Text>
  );

  return (
    <ScrollView
      role="main"
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.page}
    >
      {title}
      {auth.state === "signedOut" ? (
        <View style={[styles.card, { backgroundColor: c.surface }]}>
          <Text
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("charging.signIn")}
          </Text>
          <Button
            label={t("detail.signInToCharge")}
            onPress={() => router.navigate("/account")}
            testID="charging-sign-in"
          />
        </View>
      ) : auth.state === "loading" || !token ? (
        <Text
          role="status"
          style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
        >
          {t("common.loading")}
        </Text>
      ) : (
        <>
          {error && <Notice kind="error">{t("charging.loadError")}</Notice>}
          {charge ? (
            <LiveCharge
              key={charge.command.id}
              token={token}
              charge={charge}
              onDone={() => {
                setCharge(null);
                void load();
              }}
            />
          ) : (
            <Card title={t("charging.empty")} icon="bolt">
              <Text
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.md) },
                ]}
              >
                {t("charging.body")}
              </Text>
              <View style={styles.actions}>
                <Button
                  label={t("charging.scan")}
                  icon="scan"
                  onPress={() => router.push("/start")}
                  style={styles.flex}
                  testID="charging-start"
                />
                <Button
                  label={t("charging.find")}
                  icon="map"
                  variant="secondary"
                  onPress={() => router.navigate("/")}
                  style={styles.flex}
                />
              </View>
            </Card>
          )}
          {favourites.length > 0 && (
            <Card title={t("favourites.title")} icon="star">
              <FavouriteList items={favourites} />
            </Card>
          )}
          <Card title={t("history.title")} icon="clock" testID="history">
            {history === null ? (
              <Text
                role="status"
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.md) },
                ]}
              >
                {t("common.loading")}
              </Text>
            ) : history.length ? (
              <HistoryList items={history} label={t("history.title")} />
            ) : (
              <Text
                style={[
                  type.body,
                  { color: c.muted, fontSize: fs(fontSize.md) },
                ]}
              >
                {t("history.empty")}
              </Text>
            )}
          </Card>
        </>
      )}
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm + 4 },
  flex: { flexGrow: 1, flexBasis: 180 },
});
