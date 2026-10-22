import "server-only";
import { config } from "@/lib/server/config";
import { isDemo, outboundFetch } from "@/lib/server/demo";

/**
 * One interface for sending push notifications, so any provider fits: implement
 * `PushSender` and return it from `pushSender()`. Expo's push service is the example
 * (it reaches both APNs and FCM for an Expo app). Demo mode gets `DemoPushOutbox`,
 * which keeps the messages in memory and sends nothing.
 */
export type PushMessage = {
  /** The device's Expo push token. */
  to: string;
  title: string;
  body: string;
  /** For the app when the driver taps it: never a token, card or another driver's. */
  data: Record<string, string>;
};

/** Per message: ok, or a token the provider says is gone (forget it), or an error. */
export type PushTicket =
  { status: "ok" } | { status: "gone" } | { status: "error"; code: string };

export interface PushSender {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushTicket[]>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo takes at most 100 messages per request. */
const EXPO_BATCH = 100;

type ExpoTicket = {
  status?: string;
  details?: { error?: string };
};

/**
 * Expo's push service (https://docs.expo.dev/push-notifications/sending-notifications/),
 * through `outboundFetch`, with the project's access token (EXPO_ACCESS_TOKEN) so only
 * this server may push to the app's devices ("enhanced security for push" in Expo).
 */
export class ExpoPushSender implements PushSender {
  readonly name = "expo";
  constructor(
    private readonly accessToken: string,
    private readonly transport: typeof outboundFetch = outboundFetch,
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    const out: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += EXPO_BATCH) {
      const batch = messages.slice(i, i + EXPO_BATCH);
      const res = await this.transport(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          batch.map((m) => ({ ...m, sound: "default", priority: "high" })),
        ),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        // Status only: the answer may repeat the tokens.
        throw new Error(`Push provider answered HTTP ${res.status}`);
      }
      const body = (await res.json().catch(() => null)) as {
        data?: ExpoTicket[];
      } | null;
      const tickets = Array.isArray(body?.data) ? body.data : [];
      for (let j = 0; j < batch.length; j++) {
        const t = tickets[j];
        if (t?.status === "ok") out.push({ status: "ok" });
        else if (t?.details?.error === "DeviceNotRegistered")
          out.push({ status: "gone" });
        else
          out.push({
            status: "error",
            code: String(t?.details?.error ?? "no_ticket").slice(0, 40),
          });
      }
    }
    return out;
  }
}

/** Demo mode's sender: keeps the last messages in memory, labelled, and sends nothing. */
export class DemoPushOutbox implements PushSender {
  readonly name = "demo";
  readonly sent: PushMessage[] = [];
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    for (const m of messages) {
      this.sent.push(m);
      if (this.sent.length > 50) this.sent.shift();
    }
    return messages.map(() => ({ status: "ok" as const }));
  }
}

const holder = globalThis as unknown as {
  __emspDemoPush?: DemoPushOutbox;
  __emspPushOverride?: PushSender | null;
};

/** Demo mode's push outbox. */
export const demoPushOutbox = () =>
  (holder.__emspDemoPush ??= new DemoPushOutbox());

/**
 * The push sender in use: the demo outbox in demo mode (nothing is sent); Expo in live
 * mode with EXPO_ACCESS_TOKEN; else null (no push).
 */
export function pushSender(): PushSender | null {
  if (isDemo()) return demoPushOutbox();
  if (holder.__emspPushOverride !== undefined) return holder.__emspPushOverride;
  const token = config.expoAccessToken;
  return token ? new ExpoPushSender(token) : null;
}

/** Tests only: the sender live mode uses; undefined goes back to the default. */
export function setPushSenderForTests(s: PushSender | null | undefined) {
  holder.__emspPushOverride = s;
}
