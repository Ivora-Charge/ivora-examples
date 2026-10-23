"use server";

import {
  listAdapters,
  LiveDataSettingsError,
  removeAdapter,
  setAdapter,
  type AdapterSummary,
} from "@/lib/live-data/manage";
import { liveDataStore } from "@/lib/live-data/registry";
import { peerStore } from "@/lib/ocpi/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";

export type LiveDataActionState = {
  ok?: boolean;
  message?: string;
  adapters?: AdapterSummary[];
};

function asAdmin(
  form: FormData,
  fn: () => Promise<LiveDataActionState>,
): Promise<LiveDataActionState> {
  return gate(form, fn, {
    shown: (e) => e instanceof LiveDataSettingsError,
    fallback:
      "Something went wrong. Check the adapter list before trying again.",
    what: "live-data",
  });
}

const peerIdOf = (form: FormData) => {
  const id = field(form, "peerId").trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

/** Sets a peer's adapter. The key is encrypted at once and never shown again. */
export async function setAdapterAction(
  _prev: LiveDataActionState,
  form: FormData,
): Promise<LiveDataActionState> {
  return asAdmin(form, async () => {
    const peerId = peerIdOf(form);
    if (!peerId) return { ok: false, message: "Peer ID must be a UUID." };
    const saved = await setAdapter(
      {
        peerId,
        kind: field(form, "kind"),
        baseUrl: field(form, "baseUrl"),
        accountId: field(form, "accountId"),
        apiKey: field(form, "apiKey"),
      },
      { store: liveDataStore(), peers: peerStore(), actor: "admin" },
    );
    return {
      ok: true,
      message: `${saved.peerLabel} now uses the ${saved.kindLabel} adapter. The key is stored encrypted and is not shown again.`,
      adapters: [saved],
    };
  });
}

/** Removes a peer's adapter: its sessions show OCPI data only. */
export async function removeAdapterAction(
  _prev: LiveDataActionState,
  form: FormData,
): Promise<LiveDataActionState> {
  return asAdmin(form, async () => {
    const peerId = peerIdOf(form);
    if (!peerId) return { ok: false, message: "Peer ID must be a UUID." };
    const removed = await removeAdapter(peerId, {
      store: liveDataStore(),
      peers: peerStore(),
      actor: "admin",
    });
    return removed
      ? { ok: true, message: "Adapter removed. The peer shows OCPI data only." }
      : { ok: false, message: "That peer has no adapter." };
  });
}

export async function listAdaptersAction(
  _prev: LiveDataActionState,
  form: FormData,
): Promise<LiveDataActionState> {
  return asAdmin(form, async () => {
    const adapters = await listAdapters({
      store: liveDataStore(),
      peers: peerStore(),
    });
    return { ok: true, adapters, message: `${adapters.length} adapter(s).` };
  });
}
