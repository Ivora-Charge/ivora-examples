import { randomUUID } from "node:crypto";
import { firstDisplay, generatePassword, maskSecret } from "./credentials";
import { DEMO_BOOT, demoState, demoTest } from "./demo";
import * as ivora from "./ivora";
import { db } from "./store";
import type { Charger, Site } from "./types";

export function createSite(name: string, address: string): Site {
  const site = { id: randomUUID(), name, address };
  db().sites.set(site.id, site);
  return site;
}

export async function addCharger(siteId: string, name: string) {
  if (!db().sites.has(siteId)) throw new Error("Unknown site");
  const password = generatePassword();
  const demo = ivora.isDemo();
  const id = demo
    ? `demo-${randomUUID().slice(0, 8)}`
    : (await ivora.createStation(name, password)).id;
  const charger: Charger = {
    id,
    siteId,
    name,
    createdAt: new Date().toISOString(),
    demo,
    passwordMasked: maskSecret(password),
    state: "waiting",
  };
  db().chargers.set(id, charger);
  const endpoint =
    process.env.IVORA_OCPP_URL || "wss://ocpp.example.invalid/ocpp16";
  return {
    charger,
    credentials: firstDisplay({ stationId: id, password }),
    endpoint,
  };
}

/** Refresh state: demo is time-based, live polls the API (webhooks update the store too). */
export async function refresh(id: string): Promise<Charger | undefined> {
  const c = db().chargers.get(id);
  if (!c) return undefined;
  if (c.demo) {
    c.state = demoState(c.createdAt);
    if (c.state === "booted") c.boot = DEMO_BOOT;
  } else if (c.state !== "booted") {
    const s = await ivora.getStation(id);
    if (s.state === "booted" || s.state === "connected") c.state = s.state;
    if (s.boot) c.boot = s.boot;
  }
  return c;
}

export async function testCharger(id: string): Promise<Charger | undefined> {
  const c = await refresh(id);
  if (!c) return undefined;
  if (c.state !== "booted") throw new Error("Charger has not booted yet");
  c.test = c.demo ? demoTest() : await ivora.runTest(id);
  return c;
}
