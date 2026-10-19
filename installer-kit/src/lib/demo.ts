import type { BootInfo, ConnectionState, TestResult } from "./types";

export const DEMO_CONNECT_AFTER_MS = 4000;

export const DEMO_BOOT: BootInfo = {
  vendor: "DemoCharge (simulated)",
  model: "DC-22 Demo",
  firmware: "1.0.0-demo",
  connectors: [
    { id: 1, label: "Connector 1" },
    { id: 2, label: "Connector 2" },
  ],
};

/** The simulated charger "connects" a few seconds after creation. Pure function of time. */
export function demoState(
  createdAt: string,
  now = Date.now(),
): ConnectionState {
  const age = now - Date.parse(createdAt);
  if (age >= DEMO_CONNECT_AFTER_MS) return "booted";
  if (age >= DEMO_CONNECT_AFTER_MS / 2) return "connected";
  return "waiting";
}

export function demoTest(now = new Date()): TestResult {
  return {
    passed: true,
    energyKwh: 0.42,
    startedAt: new Date(now.getTime() - 30_000).toISOString(),
    finishedAt: now.toISOString(),
    config: { HeartbeatInterval: 300, MeterValueSampleInterval: 60 },
  };
}
