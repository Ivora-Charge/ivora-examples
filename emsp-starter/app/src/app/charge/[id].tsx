import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../components/AuthProvider";
import { Choice, ChoiceGroup } from "../../components/Choice";
import { Button } from "../../components/Controls";
import { StatusGlyph } from "../../components/Icon";
import { Card, Fact, Notice, Page } from "../../components/Page";
import { i18n, t } from "../../i18n";
import {
  ApiError,
  getCards,
  getLocation,
  getQuote,
  startCharge,
} from "../../lib/api";
import { cardLabel, problemText } from "../../lib/charge-words";
import {
  oneRequest,
  startProblem,
  type Card as SavedCard,
  type Quote,
} from "../../lib/charging";
import { present } from "../../lib/present";
import { startPush } from "../../lib/push";
import { evseKind } from "../../lib/status";
import type { LocationDetail } from "../../lib/types";
import { fontSize, space, type, useScale, useTheme } from "../../theme";

const p = present(i18n);

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; location: LocationDetail; cards: SavedCard[] };

/** A connector the driver can pick: its EVSE, the connector and how it shows. */
type Option = {
  key: string;
  evseUid: string;
  connectorId: string;
  label: string;
  detail: string;
  down: boolean;
  kind: ReturnType<typeof evseKind>;
};

/**
 * Before a start: pick the connector, see its price, the hold on the card and the card,
 * and confirm. The server then holds the card and sends START_SESSION; the app only
 * asks. The request ID is kept until the server answers for sure, so a retry after a
 * lost response replays the same start and never holds the card or starts twice.
 */
export default function ConfirmCharge() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const { id, evse } = useLocalSearchParams<{ id: string; evse?: string }>();
  const token = auth.token;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [picked, setPicked] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One request ID per start: a double tap or a retry returns the same start.
  const request = useState(oneRequest)[0];

  useEffect(() => {
    if (!token) return;
    let live = true;
    Promise.all([getLocation(id), getCards(token)]).then(
      ([location, cards]) =>
        live && setLoad({ state: "ready", location, cards }),
      (e: unknown) =>
        live &&
        setLoad({
          state: "error",
          message:
            e instanceof ApiError && e.code === "not_found"
              ? t("detail.notFound")
              : t("detail.error"),
        }),
    );
    return () => {
      live = false;
    };
  }, [id, token]);

  const options = useMemo<Option[]>(() => {
    if (load.state !== "ready") return [];
    return load.location.evses.flatMap((e) =>
      e.connectors.map((x) => {
        const kind = evseKind(e.status);
        const price = x.price ? p.detailPrice(x.price) : undefined;
        return {
          key: `${e.uid}/${x.id}`,
          evseUid: e.uid,
          connectorId: x.id,
          label: t("detail.connector", {
            standard: p.connector(x.standard),
            power: i18n.kw(x.max_power_kw),
          }),
          detail: [
            e.evse_id ?? e.uid,
            p.status(kind),
            price && [price.amount, price.unit].filter(Boolean).join(" "),
          ]
            .filter(Boolean)
            .join(" · "),
          down: kind === "down" || e.status === "REMOVED",
          kind,
        };
      }),
    );
  }, [load]);

  // The connector of the scanned EVSE, else the first free one, else the first usable.
  useEffect(() => {
    if (picked || !options.length) return;
    const usable = options.filter((o) => !o.down);
    const first =
      usable.find((o) => o.evseUid === evse) ??
      usable.find((o) => o.kind === "free") ??
      usable[0];
    if (first) setPicked(first.key);
  }, [options, evse, picked]);

  const choice = options.find((o) => o.key === picked);

  useEffect(() => {
    if (!token || !choice) return;
    let live = true;
    setQuote(null);
    getQuote(token, id, choice.evseUid, choice.connectorId).then(
      (q) => live && setQuote(q),
      () => live && setQuote(null),
    );
    return () => {
      live = false;
    };
  }, [token, id, choice?.evseUid, choice?.connectorId]);

  const start = async (hasCard: boolean) => {
    if (!token || !choice) return;
    if (!hasCard) return router.push("/wallet");
    setBusy(true);
    setError("");
    try {
      // A refused or failed start is over: the next tap is a new request.
      const res = await request.send(
        (requestId) =>
          startCharge(token, {
            requestId,
            locationId: id,
            evseUid: choice.evseUid,
            connectorId: choice.connectorId,
          }),
        (r) => r.state !== "busy" && startProblem(r.command) !== null,
      );
      const problem = res.state === "busy" ? null : startProblem(res.command);
      if (problem) {
        setError(problemText(problem));
        return;
      }
      // Ask for notifications now, when the driver sees why (phones only).
      void startPush(token, { ask: true }).catch(() => {});
      // Back to the tabs already under this screen, on the Charging tab.
      router.dismissTo("/charging");
    } catch (e) {
      // No answer or a server error keeps the request ID (see oneRequest).
      setError(
        e instanceof ApiError
          ? e.code === "unreachable"
            ? t("common.unreachable")
            : e.code === "http_403"
              ? t("start.problem.blocked")
              : e.code === "not_found"
                ? t("detail.notFound")
                : t("start.problem.failed")
          : t("start.problem.failed"),
      );
    } finally {
      setBusy(false);
    }
  };

  if (auth.state === "signedOut")
    return (
      <Page title={t("confirm.title")}>
        <Notice kind="info">{t("confirm.signIn")}</Notice>
        <Button
          label={t("detail.signInToCharge")}
          onPress={() => router.push("/account")}
        />
      </Page>
    );

  if (load.state !== "ready")
    return (
      <Page title={t("confirm.title")}>
        {load.state === "loading" ? (
          <Text
            role="status"
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("common.loading")}
          </Text>
        ) : (
          <Notice kind="error">{load.message}</Notice>
        )}
      </Page>
    );

  const card = load.cards.find((x) => x.isDefault);
  const price = (() => {
    const e = load.location.evses.find((x) => x.uid === choice?.evseUid);
    const x = e?.connectors.find((y) => y.id === choice?.connectorId);
    return x?.price ? p.detailPrice(x.price) : undefined;
  })();

  return (
    <Page title={t("confirm.title")} testID="confirm-screen">
      <Text
        style={[type.strong, { color: c.text, fontSize: fs(fontSize.lg) }]}
        testID="confirm-place"
      >
        {load.location.name}
      </Text>
      <Card title={t("confirm.connector")} icon="plug">
        <ChoiceGroup label={t("confirm.connector")}>
          {options.map((o) => (
            <Choice
              key={o.key}
              label={o.label}
              detail={o.detail}
              selected={o.key === picked}
              disabled={o.down}
              onPress={() => setPicked(o.key)}
              aside={
                <StatusGlyph
                  kind={o.kind}
                  color={
                    o.kind === "free"
                      ? c.free
                      : o.kind === "busy"
                        ? c.busy
                        : o.kind === "down"
                          ? c.danger
                          : c.muted
                  }
                />
              }
              testID={`connector-${o.key}`}
            />
          ))}
        </ChoiceGroup>
      </Card>

      <Card title={t("confirm.payment")} icon="card">
        <Fact
          label={t("detail.price")}
          value={
            price
              ? [price.amount, price.unit, price.vat].filter(Boolean).join(" ")
              : t("price.unknown")
          }
          testID="confirm-price"
        />
        <Fact
          label={t("confirm.hold")}
          value={
            quote?.holdAmount != null
              ? i18n.minor(quote.holdAmount, quote.currency)
              : "…"
          }
          strong
          testID="confirm-hold"
        />
        <Fact
          label={t("confirm.card")}
          value={card ? cardLabel(card) : t("confirm.noCard")}
          testID="confirm-card"
        />
        <View style={styles.gap}>
          <Text
            style={[
              type.body,
              { color: c.muted, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("confirm.holdNote")}
          </Text>
          {quote?.mayRaise && (
            <Text
              style={[
                type.body,
                { color: c.muted, fontSize: fs(fontSize.sm + 1) },
              ]}
            >
              {t("confirm.raiseNote")}
            </Text>
          )}
          {quote?.demo && (
            <Text
              style={[
                type.strong,
                { color: c.text, fontSize: fs(fontSize.sm + 1) },
              ]}
            >
              {t("confirm.demo")}
            </Text>
          )}
        </View>
        <Button
          label={card ? t("confirm.changeCard") : t("wallet.addOrChoose")}
          variant="secondary"
          icon="wallet"
          onPress={() => router.push("/wallet")}
          testID="confirm-change-card"
        />
      </Card>

      {quote && quote.holdAmount === null && (
        <Notice kind="error">{t("confirm.noPayments")}</Notice>
      )}
      {error ? (
        <Notice kind="error" testID="confirm-error">
          {error}
        </Notice>
      ) : null}
      {!card && <Notice kind="info">{t("confirm.needCard")}</Notice>}
      <Button
        label={card ? t("confirm.start") : t("wallet.addOrChoose")}
        icon={card ? "bolt" : "wallet"}
        busy={busy}
        onPress={() => void start(!!card)}
        testID="confirm-start"
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { gap: space.xs + 2 },
});
