import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { i18n, t } from "../i18n";
import { forgetPushToken, savePushToken } from "./api";
import { isOfflineDemo } from "./config";

/**
 * Push notifications on iOS and Android (Expo notifications): the server says when
 * charging is done, when a start or stop fails, and when the card did not approve more
 * charging. The device's Expo push token goes to the server, with the device's language
 * for the words; the server holds the provider's key. The web build has no push
 * (push.web.ts), and the offline demo saves nothing (no server to send one).
 */
export const pushSupported = true;

export type PushState = "on" | "off" | "denied" | "unavailable" | "demo";

/** What the driver taps on: which charge it is about. */
export type PushData = { kind?: string; chargeId?: string };

// While the app is open it shows the news itself: a quiet entry in the list only.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

let saved: string | null = null;

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as
    { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** Whether notifications are on for this app, without asking. */
export async function pushState(): Promise<PushState> {
  if (isOfflineDemo()) return "demo";
  if (!Device.isDevice || !projectId()) return "unavailable";
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted"
    ? saved
      ? "on"
      : "off"
    : status === "denied"
      ? "denied"
      : "off";
}

/**
 * Turns notifications on: asks the driver when `ask` is set (never on its own), gets
 * this device's Expo push token and saves it on the server.
 */
export async function startPush(
  accessToken: string,
  { ask }: { ask: boolean },
): Promise<PushState> {
  if (isOfflineDemo()) return "demo";
  const id = projectId();
  if (!Device.isDevice || !id) return "unavailable";
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("charging", {
      name: t("push.channel"),
      importance: Notifications.AndroidImportance.HIGH,
    });
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted" && ask)
    ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== "granted") return status === "denied" ? "denied" : "off";
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await savePushToken(accessToken, {
    token: data,
    platform: Platform.OS === "ios" ? "ios" : "android",
    locale: i18n.locale,
  });
  saved = data;
  return "on";
}

/** Forgets this device on the server (sign-out, or notifications off). */
export async function stopPush(accessToken: string): Promise<void> {
  if (!saved) return;
  const token = saved;
  saved = null;
  await forgetPushToken(accessToken, token);
}

/** Calls `handler` when the driver taps a notification. Returns the unsubscribe. */
export function onPushOpened(handler: (data: PushData) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) =>
    handler((r.notification.request.content.data ?? {}) as PushData),
  );
  return () => sub.remove();
}
