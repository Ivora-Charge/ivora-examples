import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../components/AuthProvider";
import { Button } from "../../components/Controls";
import { Card, Fact, Notice, Page } from "../../components/Page";
import { i18n, t } from "../../i18n";
import { ApiError, emailReceipt, getReceipt } from "../../lib/api";
import { stopText } from "../../lib/charge-words";
import type { Receipt } from "../../lib/charging";
import { present } from "../../lib/present";
import { fontSize, space, type, useScale, useTheme } from "../../theme";

const p = present(i18n);

type Load =
  | { state: "loading" }
  | { state: "notReady" }
  | { state: "error" }
  | { state: "ready"; receipt: Receipt };

/**
 * A charge's receipt, from the CPO's CDR and the payment's own figures: where and when,
 * the energy, what the session cost, what was held, charged and refunded, and why the
 * session stopped when we stopped it. The driver can have it emailed again.
 */
export default function ReceiptPage() {
  const { c } = useTheme();
  const { fs } = useScale();
  const auth = useAuth();
  const token = auth.token;
  const { id } = useLocalSearchParams<{ id: string }>();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [mail, setMail] = useState<{
    kind: "success" | "info" | "error";
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    getReceipt(token, id).then(
      (receipt) => live && setLoad({ state: "ready", receipt }),
      (e: unknown) =>
        live &&
        setLoad(
          e instanceof ApiError && e.code === "http_409"
            ? { state: "notReady" }
            : { state: "error" },
        ),
    );
    return () => {
      live = false;
    };
  }, [token, id]);

  const send = async () => {
    if (!token) return;
    setBusy(true);
    setMail(null);
    try {
      const res = await emailReceipt(token, id);
      setMail(
        res.demo
          ? { kind: "info", text: t("receipt.emailDemo") }
          : { kind: "success", text: t("receipt.emailed") },
      );
    } catch (e) {
      setMail({
        kind: "error",
        text:
          e instanceof ApiError && e.code === "rate_limited"
            ? t("receipt.emailLimited")
            : e instanceof ApiError && e.code === "http_503"
              ? t("receipt.emailOff")
              : t("receipt.emailFailed"),
      });
    } finally {
      setBusy(false);
    }
  };

  if (load.state !== "ready")
    return (
      <Page title={t("receipt.title")}>
        {load.state === "loading" ? (
          <Text
            role="status"
            style={[type.body, { color: c.muted, fontSize: fs(fontSize.md) }]}
          >
            {t("common.loading")}
          </Text>
        ) : (
          <Notice
            kind={load.state === "notReady" ? "info" : "error"}
            testID="receipt-not-ready"
          >
            {load.state === "notReady"
              ? t("receipt.notReady")
              : t("receipt.error")}
          </Notice>
        )}
      </Page>
    );

  const r = load.receipt;
  const money = (minor: number) => i18n.minor(minor, r.currency);
  const why = stopText(r.stopCode, { minor: r.held, currency: r.currency });
  const where = [r.place.name, r.place.address, r.place.city]
    .filter(Boolean)
    .join(", ");

  return (
    <Page title={t("receipt.title")} testID="receipt">
      {r.demo && <Notice kind="info">{t("receipt.demo")}</Notice>}
      <Card title={r.place.name ?? t("receipt.session")} icon="receipt">
        <Fact label={t("receipt.where")} value={where} />
        <Fact label={t("receipt.charger")} value={r.place.evseId} />
        {r.place.connector ? (
          <Fact
            label={t("receipt.connector")}
            value={p.connector(r.place.connector)}
          />
        ) : null}
        <Fact label={t("receipt.started")} value={i18n.dateTime(r.startedAt)} />
        <Fact label={t("receipt.ended")} value={i18n.dateTime(r.endedAt)} />
        <Fact
          label={t("receipt.duration")}
          value={i18n.duration(r.hours * 3600)}
        />
        <Fact
          label={t("receipt.energy")}
          value={i18n.kwh(r.kwh)}
          testID="receipt-energy"
        />
      </Card>
      <Card title={t("receipt.payment")} icon="card">
        <Fact
          label={t("receipt.sessionCost")}
          value={t(
            r.sessionCost.vatIncluded ? "receipt.inclVat" : "receipt.exclVat",
            {
              amount: money(r.sessionCost.amount),
            },
          )}
        />
        <Fact label={t("receipt.held")} value={money(r.held)} />
        <Fact
          label={t("receipt.charged")}
          value={money(r.charged)}
          strong
          testID="receipt-charged"
        />
        {r.refunded > 0 && (
          <Fact label={t("receipt.refunded")} value={money(r.refunded)} />
        )}
        {r.paymentStatus === "released" && (
          <Text
            style={[
              type.body,
              { color: c.text, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("receipt.released")}
          </Text>
        )}
        {r.shortfall ? (
          <Text
            style={[
              type.body,
              { color: c.text, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("receipt.shortfall", { amount: money(r.charged) })}
          </Text>
        ) : null}
        {r.underReview && !why && (
          <Text
            style={[
              type.body,
              { color: c.muted, fontSize: fs(fontSize.sm + 1) },
            ]}
          >
            {t("receipt.review")}
          </Text>
        )}
      </Card>
      {why && (
        <Notice
          kind="warning"
          title={t("charge.stoppedTitle")}
          testID="receipt-stop-reason"
        >
          {why}
        </Notice>
      )}
      {mail && (
        <Notice kind={mail.kind} testID="receipt-email-result">
          {mail.text}
        </Notice>
      )}
      <View style={styles.actions}>
        <Button
          label={t("receipt.email")}
          icon="mail"
          busy={busy}
          onPress={() => void send()}
          testID="receipt-email"
        />
        {r.locationId && (
          <Button
            label={t("report.open")}
            icon="flag"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: "/report",
                params: { location: r.locationId! },
              })
            }
            testID="receipt-report"
          />
        )}
      </View>
      <Text
        style={[type.mono, { color: c.muted, fontSize: fs(fontSize.xs) }]}
        selectable
      >
        {t("receipt.reference", { id: r.paymentId })}
      </Text>
    </Page>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space.sm + 4 },
});
