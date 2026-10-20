import type { BootInfo, ConnectionState } from "./types";

/** The simulated charger connects, then boots, a few seconds after creation. */
export const DEMO_CONNECT_AFTER_MS = 2000;
export const DEMO_BOOT_AFTER_MS = 4000;
/** Simulated charging power for the test session. */
export const DEMO_POWER_W = 11_000;
/** Meter register at the start of the demo test, in Wh as OCPP 1.6 reports it. */
export const DEMO_METER_START_WH = 1_204_350;

export const DEMO_BOOT: BootInfo = {
  vendor: "DemoCharge (simulated)",
  model: "DC-22 Demo",
  firmware: "1.0.0-demo",
};

export const DEMO_LOCATIONS = [
  {
    locationId: "demo-loc-1",
    name: "Sample Depot (demo)",
    address: "1 Example Way, Springfield",
  },
  {
    locationId: "demo-loc-2",
    name: "Sample Garage (demo)",
    address: "20 Placeholder Rd, Springfield",
  },
];

/** Pure function of time, so the demo needs no timers or network. */
export function demoState(
  createdAt: string,
  now = Date.now(),
): ConnectionState {
  const age = now - Date.parse(createdAt);
  if (age >= DEMO_BOOT_AFTER_MS) return "booted";
  if (age >= DEMO_CONNECT_AFTER_MS) return "connected";
  return "waiting";
}

/** Meter register (Wh) of the simulated charger, `elapsedMs` into a session. */
export function demoMeterWh(elapsedMs: number): number {
  return (
    DEMO_METER_START_WH +
    Math.round((DEMO_POWER_W * Math.max(0, elapsedMs)) / 3_600_000)
  );
}
