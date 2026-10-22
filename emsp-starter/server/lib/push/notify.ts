import "server-only";
import { after } from "next/server";
import { onCommandEvent, type CommandEvent } from "@/lib/commands/events";
import { driverAppStore } from "@/lib/driver-app/registry";
import type { DriverAppStore } from "@/lib/driver-app/store";
import { onPaymentEvent, type PaymentEvent } from "@/lib/payments/events";
import { INCREMENT_DECLINED_REASON } from "@/lib/payments/settle";
import { onSessionEvent, type SessionEvent } from "@/lib/sessions/events";
import { formatAmount, formatKwh, pushText, type PushKind } from "./messages";
import { pushSender, type PushSender } from "./sender";

/**
 * Push notifications to the driver's devices, from the server's own events:
 *
 * - `session.completed` of one of our drivers' sessions: "Charging finished".
 * - `command.finished` of a start that failed, was refused or timed out, and of a
 *   stop that failed or timed out. A refused payment hold is not pushed: the app is
 *   waiting for that answer and shows it.
 * - `hold_increment_declined`: "Your card didn't approve more charging; session
 *   stopped at {amount}", with the amount the card covers, in the device's locale.
 *   That session's "Charging finished" is not sent as well.
 *
 * Each device gets the words of its own language (MESSAGES). Demo mode never sends:
 * `pushSender()` is the in-memory outbox there. A token the provider says is gone is
 * forgotten. A failed send is logged by code and not retried.
 *
 * The listeners never hold up the request that emitted the event (a CPO's session, CDR
 * or command result): each notification runs after the response (`later`).
 */
export type NotifyDeps = {
  store: DriverAppStore;
  sender: PushSender | null;
};

const defaults = (): NotifyDeps => ({
  store: driverAppStore(),
  sender: pushSender(),
});

export async function notifyDriver(
  driverRef: string,
  kind: PushKind,
  vars: (locale: string) => Record<string, string>,
  data: Record<string, string>,
  deps: NotifyDeps = defaults(),
): Promise<number> {
  if (!deps.sender) return 0;
  const tokens = await deps.store.listPushTokens(driverRef);
  if (!tokens.length) return 0;
  const messages = tokens.map((t) => ({
    to: t.token,
    ...pushText(kind, t.locale, vars(t.locale)),
    data: { kind, ...data },
  }));
  let sent = 0;
  try {
    const tickets = await deps.sender.send(messages);
    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i];
      if (t.status === "ok") sent++;
      else if (t.status === "gone")
        await deps.store.forgetPushToken(tokens[i].token);
      else console.warn(`Push ${kind} was not delivered: ${t.code}`);
    }
  } catch (e) {
    console.error(
      `Push ${kind} failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
  }
  return sent;
}

export async function onSession(
  event: SessionEvent,
  deps: NotifyDeps = defaults(),
) {
  if (event.type !== "session.completed") return;
  const s = event.session;
  if (!s.driverRef || !s.commandId) return;
  // Told already, in other words (hold_increment_declined).
  if (s.stopReason === INCREMENT_DECLINED_REASON) return;
  if (s.session.status === "INVALID") return;
  await notifyDriver(
    s.driverRef,
    "charging_done",
    (locale) => ({ kwh: formatKwh(s.session.kwh, locale) }),
    { chargeId: s.commandId },
    deps,
  );
}

const START_KIND: Partial<Record<string, PushKind>> = {
  failed: "start_failed",
  not_supported: "start_not_supported",
  timed_out: "start_no_answer",
};
const STOP_KIND: Partial<Record<string, PushKind>> = {
  failed: "stop_failed",
  timed_out: "stop_no_answer",
};

export async function onCommand(
  event: CommandEvent,
  deps: NotifyDeps = defaults(),
) {
  const c = event.command;
  // Not pushed: a start that succeeded, or whose hold was refused (the app shows it).
  const kind = (c.type === "START_SESSION" ? START_KIND : STOP_KIND)[c.status];
  if (!kind) return;
  // A stop the payments module sent after a declined raise is told by that push.
  if (c.type === "STOP_SESSION" && c.requestId.startsWith("hold-declined:"))
    return;
  // The app opens the charge of a start; a stop's opens the Charging tab.
  const data: Record<string, string> =
    c.type === "START_SESSION" ? { chargeId: c.id } : {};
  await notifyDriver(c.driverRef, kind, () => ({}), data, deps);
}

export async function onPayment(
  event: PaymentEvent,
  deps: NotifyDeps = defaults(),
) {
  if (event.type !== "hold_increment_declined") return;
  await notifyDriver(
    event.driverRef,
    "hold_increment_declined",
    (locale) => ({
      amount: formatAmount(event.authorizedAmount, event.currency, locale),
    }),
    { chargeId: event.commandId },
    deps,
  );
}

const holder = globalThis as unknown as {
  __emspPushListening?: boolean;
  __emspPushPending?: Set<Promise<void>>;
};
const pending = () => (holder.__emspPushPending ??= new Set());

/**
 * Runs `task` once the current response has been sent (Next's `after`), so a slow push
 * provider never delays the CPO's request or changes its answer. Outside a request
 * (a script, a unit test) it starts the task without waiting for it. Never throws.
 */
export function later(task: () => Promise<unknown>): void {
  const run = () => {
    const p: Promise<void> = task()
      .then(() => undefined)
      .catch((e: unknown) =>
        console.error(
          `A push notification failed: ${e instanceof Error ? e.name : "unknown error"}`,
        ),
      )
      .finally(() => pending().delete(p));
    pending().add(p);
    return p;
  };
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Waits for the notifications started so far (tests). */
export async function flushPushForTests(): Promise<void> {
  while (pending().size) await Promise.all([...pending()]);
}

/**
 * Subscribes the notifications to session, command and payment events, in this server
 * process. Called by the routes that receive or change sessions, commands and
 * payments; installing twice does nothing.
 */
export function installPushListeners(): () => void {
  if (holder.__emspPushListening) return () => undefined;
  holder.__emspPushListening = true;
  const offs = [
    onSessionEvent((e) => later(() => onSession(e))),
    onCommandEvent((e) => later(() => onCommand(e))),
    onPaymentEvent((e) => later(() => onPayment(e))),
  ];
  return () => {
    for (const off of offs) off();
    holder.__emspPushListening = false;
  };
}
