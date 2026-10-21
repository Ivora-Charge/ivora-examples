"use server";

import {
  connectToCpo,
  HandshakeError,
  invitePeer,
  rotateCredentials,
  unregisterPeer,
} from "@/lib/ocpi/handshake";
import { peerStore } from "@/lib/ocpi/registry";
import type { Peer } from "@/lib/ocpi/store";
import { adminEnabled, isAdminSecret } from "@/lib/server/admin";

/** A peer as the admin web shows it: no token, no ciphertext. */
export type PeerSummary = {
  id: string;
  label: string;
  direction: Peer["direction"];
  status: Peer["status"];
  versionsUrl: string | null;
  parties: string[];
  modules: string[];
  registeredAt: string | null;
};

export type ActionState = {
  ok?: boolean;
  message?: string;
  peer?: PeerSummary;
  peers?: PeerSummary[];
  /** Shown once, right after an invitation. Only its hash is stored. */
  tokenA?: string;
  versionsUrl?: string;
};

function summary(p: Peer): PeerSummary {
  return {
    id: p.id,
    label: p.label,
    direction: p.direction,
    status: p.status,
    versionsUrl: p.versionsUrl,
    parties: p.roles.map(
      (r) =>
        `${r.role} ${r.country_code}-${r.party_id} (${r.business_details.name})`,
    ),
    modules: [...new Set(p.endpoints.map((e) => e.identifier))].sort(),
    registeredAt: p.registeredAt,
  };
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * Runs `fn` only for an admin. Errors become a message for the form; only handshake
 * and demo-mode errors carry their own text, which never includes a token.
 */
async function asAdmin(
  form: FormData,
  fn: () => Promise<ActionState>,
): Promise<ActionState> {
  if (!adminEnabled())
    return {
      ok: false,
      message:
        "Admin actions are disabled: set ADMIN_SECRET (at least 32 characters) on the server.",
    };
  if (!isAdminSecret(field(form, "adminSecret")))
    return { ok: false, message: "Wrong admin secret." };
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HandshakeError) return { ok: false, message: e.message };
    if (e instanceof Error && "code" in e && e.code === "demo_mode")
      return { ok: false, message: e.message };
    console.error(
      `Admin peer action failed: ${e instanceof Error ? e.name : "unknown error"}`,
    );
    return {
      ok: false,
      message: "Something went wrong. Check the peer list before trying again.",
    };
  }
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
    const { peer, tokenA, versionsUrl } = await invitePeer(
      { label: field(form, "label") },
      { store: peerStore(), actor: "admin" },
    );
    return {
      ok: true,
      message: `Invitation for ${peer.label} created. Send the CPO this versions URL and Token A over a secure channel. The token is shown only once.`,
      peer: summary(peer),
      tokenA,
      versionsUrl,
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

/** Every peer, for the admin. */
export async function listPeersAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return asAdmin(form, async () => {
    const peers = (await peerStore().listPeers()).map(summary);
    return { ok: true, peers, message: `${peers.length} peer(s).` };
  });
}
