/**
 * The web build has no push notifications (see push.ts for phones). The charging
 * screen shows the same news while it is open.
 */
export const pushSupported = false;

export type PushState = "on" | "off" | "denied" | "unavailable" | "demo";
export type PushData = { kind?: string; chargeId?: string };

export async function pushState(): Promise<PushState> {
  return "unavailable";
}

export async function startPush(
  _accessToken: string,
  _options: { ask: boolean },
): Promise<PushState> {
  return "unavailable";
}

export async function stopPush(_accessToken: string): Promise<void> {}

export function onPushOpened(_handler: (data: PushData) => void): () => void {
  return () => {};
}
