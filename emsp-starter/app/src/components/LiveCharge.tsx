import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { i18n, t } from "../i18n";
import { ApiError, getCharge, getChargeSession, stopCharge } from "../lib/api";
import { problemText, stopText } from "../lib/charge-words";
import {
  oneRequest,
  phaseOf,
  secondsSince,
  startProblem,
  type Charge,
  type SessionState,
} from "../lib/charging";
import { fontSize, radius, space, type, useScale, useTheme } from "../theme";
import { Button } from "./Controls";
import { LiveReadout } from "./LiveReadout";
import { Notice } from "./Page";

/** How often the screen asks the server while a charge runs. */
const POLL_MS = 3000;

/**
 * A charge, live: what it is doing (starting, charging, stopping, finished), the energy,
 * the time, the cost so far as the CPO reports it, and the battery when the CPO's
 * live-data adapter knows it (part 9), with a stop button. It asks the server every
 * few seconds; the server tells the phone's notifications too, when the app is closed.
 * When the card did not approve a higher hold, it says so in plain words, never as a
 * charger fault.
 */
export function LiveCharge({
  token,
  charge: first,
  onDone,
}: {
  token: string;
  charge: Charge;
  /** The driver closes the finished (or failed) charge. */
  onDone: () => void;
}) {
  const { c } = useTheme();
  const { fs } = useScale();
  const [charge, setCharge] = useState(first);
  const [state, setState] = useState<SessionState | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const [now, setNow] = useState(Date.now());
  // One request ID per stop, kept until the server answers for sure (see oneRequest).
  const stopRequest = useState(oneRequest)[0];

  const phase = phaseOf(charge, state, stopping);
  const over = phase === "finished" || phase === "failed";

  const refresh = useCallback(async () => {
    try {
      if (charge.command.pending) {
        const next = await getCharge(token, charge.command.id);
        setCharge((c0) => ({ ...c0, ...next }));
      } else {
        const next = await getChargeSession(token, charge.command.id);
        setState(next);
        if (next.session && !next.session.open) setStopping(false);
      }
    } catch {
      // Offline for a moment: the next poll tries again.
    }
    setNow(Date.now());
  }, [token, charge.command.id, charge.command.pending]);

  useEffect(() => {
    void refresh();
    if (over) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, over]);

  const stop = async () => {
    setStopError("");
    setStopping(true);
    try {
      const failed = (r: { command: Charge["command"] }) =>
        !r.command.pending && r.command.status !== "succeeded";
      const res = await stopRequest.send(
        (requestId) => stopCharge(token, charge.command.id, requestId),
        failed,
      );
      if (failed(res)) {
        setStopping(false);
        setStopError(t("charge.stopFailed"));
      }
      await refresh();
    } catch (e) {
      setStopping(false);
      setStopError(
        e instanceof ApiError && e.code === "http_409"
          ? t("charge.stopTooSoon")
          : e instanceof ApiError && e.code === "unreachable"
            ? t("common.unreachable")
            : t("charge.stopFailed"),
      );
    }
  };

  const session = state?.session;
  const payment = state?.payment ?? charge.payment;
  const place = state?.place ?? charge.place;
  const problem = startProblem(charge.command);
  const stopCode = session?.stopCode ?? payment?.stopCode ?? null;
  const stopped =
    payment &&
    stopText(stopCode, {
      minor: payment.authorizedAmount,
      currency: payment.currency,
    });
  const seconds = session
    ? session.endedAt
      ? secondsSince(session.startedAt, Date.parse(session.endedAt))
      : secondsSince(session.startedAt, now)
    : 0;

  const PHASE_TEXT = {
    starting: t("charge.phase.starting"),
    charging: t("charge.phase.charging"),
    stopping: t("charge.phase.stopping"),
    finished: t("charge.phase.finished"),
    failed: t("charge.phase.failed"),
  };

  const big = [type.heading, { color: c.text, fontSize: fs(fontSize.xxl) }];
  const small = [type.body, { color: c.muted, fontSize: fs(fontSize.sm) }];

  return (
    <View
      style={[styles.card, { backgroundColor: c.surface }]}
      testID="live-charge"
    >
      <View style={[styles.head, { backgroundColor: c.primary }]}>
        <Text
          role="heading"
          aria-level={2}
          style={[
            type.heading,
            { color: c.onPrimary, fontSize: fs(fontSize.xl) },
          ]}
          testID="live-place"
        >
          {place?.name ?? t("charge.title")}
        </Text>
        <Text
          role="status"
          style={[
            type.strong,
            { color: c.onPrimary, fontSize: fs(fontSize.md) },
          ]}
          testID="live-phase"
        >
          {PHASE_TEXT[phase]}
        </Text>
      </View>

      <View style={styles.body}>
        {phase === "failed" && problem ? (
          <Notice kind="error" testID="live-problem">
            {problemText(problem)}
          </Notice>
        ) : (
          <View style={styles.numbers}>
            <View style={styles.number}>
              <Text style={big} testID="live-kwh">
                {i18n.kwh(session?.kwh ?? 0)}
              </Text>
              <Text style={small}>{t("charge.energy")}</Text>
            </View>
            <View style={styles.number}>
              <Text style={big} testID="live-time">
                {i18n.duration(seconds)}
              </Text>
              <Text style={small}>{t("charge.time")}</Text>
            </View>
            <View style={styles.number}>
              <Text style={big} testID="live-cost">
                {session?.cost
                  ? i18n.minor(session.cost.amount, session.currency)
                  : "–"}
              </Text>
              <Text style={small}>
                {session?.cost
                  ? over
                    ? t("charge.costFinal")
                    : t("charge.costSoFar")
                  : t("charge.costUnknown")}
              </Text>
            </View>
          </View>
        )}

        {phase === "charging" && <LiveReadout live={state?.live} now={now} />}

        {stopped && (
          <Notice
            kind="warning"
            title={t("charge.stoppedTitle")}
            testID="live-stopped-reason"
          >
            {stopped}
          </Notice>
        )}
        {stopCode === "hold_increment_declined" && (
          <Text style={small}>{t("charge.declinedNext")}</Text>
        )}
        {phase === "finished" && !stopped && (
          <Notice kind="success" testID="live-finished">
            {t("charge.finishedBody")}
          </Notice>
        )}
        {payment && !over && payment.holdAmount > 0 && (
          <Text style={small}>
            {t("charge.holdNote", {
              amount: i18n.minor(payment.authorizedAmount, payment.currency),
            })}
          </Text>
        )}
        {stopError ? (
          <Notice kind="error" testID="live-stop-error">
            {stopError}
          </Notice>
        ) : null}

        {!over && (
          <Button
            label={t("charge.stop")}
            icon="stop"
            busy={phase === "stopping"}
            onPress={() => void stop()}
            testID="live-stop"
          />
        )}
        {over && (
          <View style={styles.actions}>
            {phase === "finished" && (
              <Button
                label={t("charge.receipt")}
                icon="receipt"
                onPress={() => router.push(`/receipt/${charge.command.id}`)}
                style={styles.flex}
                testID="live-receipt"
              />
            )}
            <Button
              label={t("charge.done")}
              variant="secondary"
              onPress={onDone}
              style={styles.flex}
              testID="live-done"
            />
          </View>
        )}
        {place && (
          <Button
            label={t("report.open")}
            icon="flag"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: "/report",
                params: { location: place.id },
              })
            }
            testID="live-report"
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, overflow: "hidden" },
  head: { padding: space.lg, gap: space.xs },
  body: { padding: space.lg, gap: space.md },
  numbers: { flexDirection: "row", flexWrap: "wrap", gap: space.lg },
  number: { minWidth: 120, flexGrow: 1, gap: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm + 4 },
  flex: { flexGrow: 1, flexBasis: 160 },
});
