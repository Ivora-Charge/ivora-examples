import "server-only";
import { encryptToken } from "@/lib/ocpi/tokens";
import type { PeerStore } from "@/lib/ocpi/store";
import { ADAPTER_KINDS, keyContext } from "./registry";
import type { LiveDataSettings, LiveDataStore } from "./store";

/** A setting an admin can correct. The message names the field, never its value. */
export class LiveDataSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveDataSettingsError";
  }
}

/** A peer's adapter as the admin web shows it: no key, no ciphertext. */
export type AdapterSummary = {
  peerId: string;
  peerLabel: string;
  kind: string;
  kindLabel: string;
  baseUrl: string;
  accountId: string;
  updatedAt: string;
};

type Deps = { store: LiveDataStore; peers: PeerStore; actor: string };

function cleanBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LiveDataSettingsError("API URL must be an https:// URL.");
  }
  if (url.protocol !== "https:")
    throw new LiveDataSettingsError("API URL must be an https:// URL.");
  if (url.username || url.password || url.search || url.hash)
    throw new LiveDataSettingsError(
      "API URL must not carry a user, password, query or fragment.",
    );
  const clean = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  if (clean.length > 255)
    throw new LiveDataSettingsError("API URL is too long.");
  return clean;
}

/**
 * Sets (or replaces) the live-data adapter of a peer. The key is encrypted with
 * OCPI_TOKEN_ENCRYPTION_KEY, bound to the peer, and never logged or shown again.
 */
export async function setAdapter(
  input: {
    peerId: string;
    kind: string;
    baseUrl: string;
    accountId: string;
    apiKey: string;
  },
  { store, peers, actor }: Deps,
): Promise<AdapterSummary> {
  const kind = ADAPTER_KINDS[input.kind];
  if (!kind) throw new LiveDataSettingsError("Unknown adapter.");
  const peer = await peers.getPeer(input.peerId);
  if (!peer || peer.status === "unregistered")
    throw new LiveDataSettingsError("No such peer, or it is unregistered.");
  const baseUrl = cleanBaseUrl(input.baseUrl);
  const accountId = input.accountId.trim();
  if (!kind.accountPattern.test(accountId))
    throw new LiveDataSettingsError(`${kind.accountLabel} is invalid.`);
  const apiKey = input.apiKey.trim();
  if (!kind.keyPattern.test(apiKey))
    throw new LiveDataSettingsError("API key is invalid.");
  // Fails here, not at the first read, if the settings cannot make an adapter.
  kind.create({ baseUrl, accountId, apiKey });
  const saved = await store.put({
    peerId: peer.id,
    kind: input.kind,
    baseUrl,
    accountId,
    keyCiphertext: encryptToken(apiKey, keyContext(peer.id)),
  });
  await peers.audit({
    actor,
    action: "live_data.adapter_set",
    subjectId: peer.id,
    details: { kind: input.kind, host: new URL(baseUrl).host },
  });
  return summary(saved, peer.label);
}

/** Removes a peer's adapter: the peer goes back to the null adapter. */
export async function removeAdapter(
  peerId: string,
  { store, peers, actor }: Deps,
): Promise<boolean> {
  const removed = await store.remove(peerId);
  if (removed)
    await peers.audit({
      actor,
      action: "live_data.adapter_removed",
      subjectId: peerId,
    });
  return removed;
}

export async function listAdapters({
  store,
  peers,
}: Omit<Deps, "actor">): Promise<AdapterSummary[]> {
  const labels = new Map(
    (await peers.listPeers()).map((p) => [p.id, p.label] as const),
  );
  return (await store.list()).map((s) =>
    summary(s, labels.get(s.peerId) ?? "(unknown peer)"),
  );
}

function summary(s: LiveDataSettings, peerLabel: string): AdapterSummary {
  return {
    peerId: s.peerId,
    peerLabel,
    kind: s.kind,
    kindLabel: ADAPTER_KINDS[s.kind]?.label ?? `${s.kind} (unknown)`,
    baseUrl: s.baseUrl,
    accountId: s.accountId,
    updatedAt: s.updatedAt,
  };
}
