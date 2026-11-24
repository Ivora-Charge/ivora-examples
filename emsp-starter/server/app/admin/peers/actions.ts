"use server";

import {
  connectToCpo,
  HandshakeError,
  invitePeer,
  rotateCredentials,
  unregisterPeer,
} from "@/lib/ocpi/handshake";
import { explainMessage, explainStatus } from "@/lib/admin/errors";
import { DEMO_PEER_ID, locationStore } from "@/lib/locations/registry";
import type { SyncKey, SyncModule, SyncState } from "@/lib/locations/store";
import {
  pullTargets,
  syncKey,
  syncPeer,
  SyncError,
  type SyncReport,
} from "@/lib/locations/sync";
import {
  acceptParty,
  offerFromHub,
  removeParty,
  setHubPushMode,
} from "@/lib/ocpi/hub";
import { isHubPeer, trustedParties } from "@/lib/ocpi/parties";
import { peerStore } from "@/lib/ocpi/registry";
import type { HubParty, HubPushMode, Peer } from "@/lib/ocpi/store";
import { assertLive, isDemo } from "@/lib/server/demo";
import { asAdmin as gate, field } from "@/lib/server/admin-action";

/** The last pull of one module from a peer. */
export type ModuleSync = {
  /** The module; behind a hub 'module@CC-PID' of the party pulled. */
  module: SyncKey;
  /** When the last pull ended, ok or not; null: never pulled. */
  lastPullAt: string | null;
  lastFullSyncAt: string | null;
  ok: boolean | null;
  items: number;
  invalid: number;
  /** A pull is running, or stopped part way (the next pull resumes it). */
  running: boolean;
  error?: string;
  code?: string;
  nextStep?: string;
};

/** A peer as the admin web shows it: no token, no ciphertext. */
export type PeerSummary = {
  id: string;
  label: string;
  direction: Peer["direction"];
  status: Peer["status"];
  versionsUrl: string | null;
  parties: string[];
  /** A roaming hub: the parties behind it and whether the operator trusts them. */
  hub?: { parties: HubParty[]; pushMode: HubPushMode };
  modules: string[];
  registeredAt: string | null;
  /** Per module this server pulls; only in the peer list. */
  sync?: ModuleSync[];
  demo?: boolean;
};

const SYNC_MODULES: SyncModule[] = ["locations", "tariffs", "sessions", "cdrs"];

function moduleSync(module: SyncKey, s: SyncState | null): ModuleSync {
  const r = s?.lastResult ?? null;
  const failed = r && !r.ok;
  const help = failed
    ? (explainStatus(r.statusCode, r.httpStatus) ??
      explainMessage(r.error ?? ""))
    : null;
  return {
    module,
    lastPullAt: r?.finishedAt ?? null,
    lastFullSyncAt: s?.lastFullSyncAt ?? null,
    ok: r ? r.ok : null,
    items: r?.items ?? 0,
    invalid: r?.invalid ?? 0,
    running: Boolean(s?.run),
    ...(failed && {
      error: r.error ?? "The pull failed.",
      code: help!.code,
      nextStep: help!.nextStep,
    }),
  };
}

/** The demo's built-in mock CPO: never pulled over the network. */
const DEMO_PEER: PeerSummary = {
  id: DEMO_PEER_ID,
  label: "Mock CPO (demo, built in)",
  direction: "outbound",
  status: "registered",
  versionsUrl: null,
  parties: ["CPO ZZ-MCK (Mock CPO)"],
  modules: ["cdrs", "locations", "sessions", "tariffs"],
  registeredAt: null,
  demo: true,
};

export type ActionState = {
  ok?: boolean;
  message?: string;
  code?: string;
  nextStep?: string;
  peer?: PeerSummary;
  peers?: PeerSummary[];
  /** Shown once, right after an invitation. Only its hash is stored. */
  tokenA?: string;
  versionsUrl?: string;
  /** When the Token A stops working. */
  expiresAt?: string;
};

function summary(p: Peer): PeerSummary {
  return {
    id: p.id,
    label: p.label,
    direction: p.direction,
    status: p.status,
    versionsUrl: p.versionsUrl,
    // A hub's own CPO roles are only offers (see the hub's party list).
    parties: p.roles.map(
      (r) =>
        `${r.role} ${r.country_code}-${r.party_id} (${r.business_details.name})${isHubPeer(p) && r.role === "CPO" ? " declared by the hub, not trusted" : ""}`,
    ),
    ...(isHubPeer(p) && {
      hub: { parties: p.hubParties, pushMode: p.hubPushMode },
    }),
    modules: [...new Set(p.endpoints.map((e) => e.identifier))].sort(),
    registeredAt: p.registeredAt,
  };
}

/** Runs `fn` only for an admin; handshake and pull errors carry their own text. */
function asAdmin(
  form: FormData,
  fn: () => Promise<ActionState>,
): Promise<ActionState> {
  return gate(form, fn, {
    shown: (e) => e instanceof HandshakeError || e instanceof SyncError,
    fallback: "Something went wrong. Check the peer list before trying again.",
    what: "peer",
  });
}

/** We register at a CPO, from its versions URL and the Token A it gave us. */
export async function connectPeerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const peer = await connectToCpo(
      {
        label: field(form, "label"),
        versionsUrl: field(form, "versionsUrl"),
        tokenA: field(form, "tokenA"),
      },
      { store: peerStore(), actor: "admin" },
    );
    return {
      ok: true,
      message: `Registered at ${peer.label}.`,
      peer: summary(peer),
    };
  });
}

/** A CPO will register with us: issue its Token A. */
export async function invitePeerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const { peer, tokenA, versionsUrl, expiresAt } = await invitePeer(
      { label: field(form, "label") },
      { store: peerStore(), actor: "admin" },
    );
    return {
      ok: true,
      message: `Invitation for ${peer.label} created. Send the CPO this versions URL and Token A over a secure channel. The token is shown only once and works until ${expiresAt}.`,
      peer: summary(peer),
      tokenA,
      versionsUrl,
      expiresAt,
    };
  });
}

/** Rotate tokens with, or unregister from, a peer. */
export async function managePeerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const id = field(form, "peerId").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return { ok: false, message: "Peer ID must be a UUID." };
    const deps = { store: peerStore(), actor: "admin" };
    if (field(form, "intent") === "rotate") {
      const peer = await rotateCredentials(id, deps);
      return {
        ok: true,
        message: `Tokens rotated with ${peer.label}.`,
        peer: summary(peer),
      };
    }
    if (field(form, "intent") === "unregister") {
      const peer = await unregisterPeer(id, deps);
      return {
        ok: true,
        message: `Unregistered ${peer.label}.`,
        peer: summary(peer),
      };
    }
    return { ok: false, message: "Unknown action." };
  });
}

/** Every peer, with the last pull and its error per module, for the admin. */
export async function listPeersAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const locations = locationStore();
    const peers: PeerSummary[] = await Promise.all(
      (await peerStore().listPeers()).map(async (p) => ({
        ...summary(p),
        sync: await Promise.all(
          SYNC_MODULES.flatMap((m) =>
            pullTargets(p).map(async (party) => {
              const key = syncKey(m, party);
              return moduleSync(key, await locations.getSyncState(p.id, key));
            }),
          ),
        ),
      })),
    );
    if (isDemo()) peers.unshift(DEMO_PEER);
    const failing = peers.filter((p) => p.sync?.some((m) => m.ok === false));
    return {
      ok: true,
      peers,
      message: `${peers.length} peer(s)${failing.length ? `; ${failing.length} with a failed pull (see below)` : ""}.`,
    };
  });
}

const describeSync = (r: SyncReport) =>
  `${r.module}${r.party ? ` of ${r.party.countryCode}-${r.party.partyId}` : ""}: ${r.items} stored${r.invalid ? `, ${r.invalid} invalid skipped` : ""}${r.removed ? `, ${r.removed} removed` : ""}${r.complete ? "" : " (more pages left: pull again to continue)"}`;

/**
 * Pulls a registered peer's tariffs, then its locations: changes since the last pull,
 * or everything with intent "full".
 */
export async function syncPeerAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const id = field(form, "peerId").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return { ok: false, message: "Peer ID must be a UUID." };
    assertLive("pull locations and tariffs from a CPO");
    const mode = field(form, "intent") === "full" ? "full" : "auto";
    const deps = { peers: peerStore(), locations: locationStore() };
    const peer = await deps.peers.getPeer(id);
    if (!peer) return { ok: false, message: "No such peer." };
    const reports: SyncReport[] = [];
    if (isHubPeer(peer) && !trustedParties(peer).length)
      return {
        ok: false,
        message: `${peer.label} is a roaming hub with no trusted party: accept a party first.`,
      };
    for (const module of ["tariffs", "locations"] as const)
      if (
        peer.endpoints.some(
          (e) => e.identifier === module && e.role === "SENDER",
        )
      )
        for (const party of pullTargets(peer))
          reports.push(await syncPeer(id, module, deps, { mode, party }));
    if (!reports.length)
      return {
        ok: false,
        message: `${peer.label} has no locations or tariffs Sender endpoint.`,
      };
    return {
      ok: true,
      message: `Pulled from ${peer.label}. ${reports.map(describeSync).join("; ")}.`,
    };
  });
}

/** The caches a hub party filled: dropped when the operator stops trusting it. */
async function purgeParty(
  peerId: string,
  party: { countryCode: string; partyId: string },
) {
  const store = locationStore();
  const until = new Date(Date.now() + 60_000).toISOString();
  await store.pruneLocations(peerId, until, party);
  await store.pruneTariffs(peerId, until, party);
}

/**
 * The CPO parties behind a roaming hub: accept one (a new one, or one the hub offered),
 * stop trusting one, or read the hub's client list for parties to offer. Nothing is
 * sent to or accepted from a party until it is accepted.
 */
export async function hubPartyAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const id = field(form, "peerId").trim();
    if (!/^[0-9a-f-]{36}$/i.test(id))
      return { ok: false, message: "Peer ID must be a UUID." };
    const deps = { store: peerStore(), actor: "admin" };
    const intent = field(form, "intent");
    if (intent === "push_mode") {
      const mode = field(form, "mode") as HubPushMode;
      const peer = await setHubPushMode(id, mode, deps);
      return {
        ok: true,
        message:
          mode === "hub"
            ? `Tokens now go to ${peer.label}'s own party, in one push.`
            : `Tokens now go to each trusted party behind ${peer.label}.`,
        peer: summary(peer),
      };
    }
    if (intent === "offer") {
      const { peer, offered } = await offerFromHub(id, deps);
      return {
        ok: true,
        message: `${offered} new party(ies) offered by ${peer.label}. Accept the ones you trust.`,
        peer: summary(peer),
      };
    }
    const party = {
      countryCode: field(form, "countryCode"),
      partyId: field(form, "partyId"),
    };
    if (intent === "accept") {
      const peer = await acceptParty(
        id,
        { ...party, name: field(form, "name") },
        deps,
      );
      return {
        ok: true,
        message: `${party.countryCode.toUpperCase()}-${party.partyId.toUpperCase()} is trusted through ${peer.label}.`,
        peer: summary(peer),
      };
    }
    if (intent === "remove") {
      const peer = await removeParty(id, party, {
        ...deps,
        purge: purgeParty,
      });
      return {
        ok: true,
        message: `Removed ${party.countryCode.toUpperCase()}-${party.partyId.toUpperCase()} from ${peer.label}.`,
        peer: summary(peer),
      };
    }
    return { ok: false, message: "Unknown action." };
  });
}
