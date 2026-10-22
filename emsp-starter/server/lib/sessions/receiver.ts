import "server-only";
import { commandStore } from "@/lib/commands/registry";
import { OcpiProblem } from "@/lib/ocpi/errors";
import { parsePatch } from "@/lib/ocpi/locations";
import {
  asObject,
  checkIds,
  invalid,
  notAllowed,
  pushingParty,
  receiverPath,
  valid,
} from "@/lib/ocpi/receiver";
import { ocpiResponse, readJson, type OcpiContext } from "@/lib/ocpi/server";
import { parseCdr, parseSession } from "@/lib/ocpi/session-objects";
import { sameParty, STATUS } from "@/lib/ocpi/types";
import { ocpiUrls } from "@/lib/server/config";
import { tokenStore } from "@/lib/tokens/registry";
import {
  patchSession,
  recordCdr,
  recordSession,
  UnknownSessionError,
  type SessionDeps,
} from "./record";
import { sessionStore } from "./registry";

/**
 * Our Sessions and CDRs Receiver interfaces (OCPI 2.2.1 sections 9.2.2 and 10.2.2): a
 * CPO pushes our drivers' sessions as they run, and their CDRs once they are over.
 *
 *   /ocpi/2.2.1/sessions/{country_code}/{party_id}/{session_id}   GET, PUT, PATCH
 *   POST /ocpi/2.2.1/cdrs                                         a new CDR
 *   GET  /ocpi/2.2.1/cdrs/{id}                                    the URL we answered with
 *
 * The session's (or CDR's) country code and party ID, in the URL and the body, must be
 * the CPO party in OCPI-from, one of the calling peer's; objects are stored under that
 * peer only. Every body is validated against
 * 2.2.1. A session we do not hold is `2000 Unknown session` (HTTP 404): 2.2.1 has no
 * status for it. A CDR POSTed again is acknowledged; one with the ID of another is
 * refused with 2001, because CDRs never change (a CPO corrects one with a credit CDR).
 */
export function receiverDeps(ctx: OcpiContext): SessionDeps {
  return {
    sessions: sessionStore(),
    commands: commandStore(),
    tokens: tokenStore(),
    peers: ctx.store,
    actor: `peer:${ctx.peer.id}`,
  };
}

/** Every request to /ocpi/2.2.1/sessions/... */
export async function sessionsReceiver(
  ctx: OcpiContext,
  deps: SessionDeps = receiverDeps(ctx),
): Promise<Response> {
  const p = receiverPath(ctx, "sessions");
  if (p.rest.length) throw invalid("Path is too long");
  const key = {
    peerId: ctx.peer.id,
    countryCode: p.countryCode,
    partyId: p.partyId,
    sessionId: p.id,
  };
  const ids = { country_code: p.countryCode, party_id: p.partyId, id: p.id };
  switch (ctx.request.method) {
    case "GET": {
      const held = await deps.sessions.getSession(key);
      if (!held) throw new UnknownSessionError();
      return ocpiResponse(held.session, ctx);
    }
    case "PUT": {
      const raw = asObject(await readJson(ctx.request));
      checkIds(raw, ids);
      const session = valid("session", parseSession({ ...raw, ...ids }));
      await recordSession(ctx.peer, session, deps);
      return ocpiResponse(undefined, ctx);
    }
    case "PATCH": {
      const patch = valid("patch", parsePatch(await readJson(ctx.request)));
      checkIds(patch, ids);
      await patchSession(ctx.peer, key, patch, deps);
      return ocpiResponse(undefined, ctx);
    }
    default:
      throw notAllowed();
  }
}

const CDR_URL = /^\/ocpi\/2\.2\.1\/cdrs\/([0-9a-f-]{36})$/i;

/** Every request to /ocpi/2.2.1/cdrs and /ocpi/2.2.1/cdrs/{id}. */
export async function cdrsReceiver(
  ctx: OcpiContext,
  deps: SessionDeps = receiverDeps(ctx),
): Promise<Response> {
  const path = new URL(ctx.request.url).pathname.replace(/\/+$/, "");
  const method = ctx.request.method;

  if (path === "/ocpi/2.2.1/cdrs") {
    if (method !== "POST") throw notAllowed();
    const cdr = valid("CDR", parseCdr(await readJson(ctx.request)));
    pushingParty(
      ctx,
      { countryCode: cdr.country_code, partyId: cdr.party_id },
      "of the CDR",
    );
    const { outcome, cdr: stored } = await recordCdr(
      ctx.peer,
      cdr,
      "push",
      deps,
    );
    if (outcome === "conflict")
      throw invalid(
        "A CDR with this id was already received with other content. CDRs never change: send a credit CDR with a new id",
      );
    const res = ocpiResponse(undefined, ctx);
    // Where the CPO may read it back (OCPI 2.2.1 section 10.2.2.2).
    res.headers.set("Location", `${ocpiUrls().cdrs}/${stored.id}`);
    return res;
  }

  const m = CDR_URL.exec(path);
  if (!m) throw invalid("Unknown path");
  if (method !== "GET") throw notAllowed();
  const held = await deps.sessions.getCdrById(m[1].toLowerCase());
  // Only the peer and CPO party that sent it may read it.
  if (
    !held ||
    held.peerId !== ctx.peer.id ||
    !ctx.from ||
    !sameParty(ctx.from, {
      countryCode: held.cdr.country_code,
      partyId: held.cdr.party_id,
    })
  )
    throw new OcpiProblem(404, STATUS.CLIENT_ERROR, "Unknown CDR");
  return ocpiResponse(held.cdr, ctx);
}
