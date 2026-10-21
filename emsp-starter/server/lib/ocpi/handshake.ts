import "server-only";
import { randomUUID } from "node:crypto";
import { config, OCPI_VERSION, ocpiUrls } from "@/lib/server/config";
import { assertLive } from "@/lib/server/demo";
import { ocpiRequest, type ClientOptions } from "./client";
import { OcpiError, OcpiProblem, OcpiUnauthorizedError } from "./errors";
import { ourCredentials, ourParty } from "./identity";
import {
  parseCredentials,
  parseVersionDetails,
  parseVersions,
  TOKEN_PATTERN,
} from "./schema";
import { ocpiResponse, readJson, type OcpiContext } from "./server";
import type { Peer, PeerStore } from "./store";
import { decryptToken, encryptToken, generateToken, hashToken } from "./tokens";
import {
  sameParty,
  STATUS,
  type Credentials,
  type CredentialsRole,
  type Endpoint,
} from "./types";

/**
 * The OCPI 2.2.1 credentials handshake, from the eMSP side.
 *
 * We register at a CPO (`connectToCpo`):
 *   1. GET the CPO's versions and version details with its Token A.
 *   2. Issue our Token B; POST our credentials (carrying B) to its credentials module,
 *      authorised with Token A. The CPO calls our versions endpoint with B meanwhile.
 *   3. Store the CPO's Token C (encrypted) from the response; use it from now on.
 *
 * A CPO registers with us (`invitePeer`, then the credentials POST handler):
 *   1. We issue a Token A and hand it, with our versions URL, to the CPO out of band.
 *   2. The CPO GETs our versions with A and POSTs its credentials (Token B) with A.
 *   3. We GET its versions with B, store B (encrypted), revoke A and answer with our
 *      credentials carrying a new Token C, which the CPO uses from then on.
 *
 * Either side can then rotate tokens (credentials PUT) or unregister (DELETE).
 */

/** A handshake step failed. The message is safe to show an admin: no tokens. */
export class HandshakeError extends Error {
  constructor(
    message: string,
    /** OCPI status code to answer a peer with, when the peer started the handshake. */
    readonly statusCode: number = STATUS.UNABLE_TO_USE_CLIENT_API,
  ) {
    super(message);
    this.name = "HandshakeError";
  }
}

export type HandshakeDeps = {
  store: PeerStore;
  client?: ClientOptions;
  /** Who acted, for the audit log, for example 'admin'. */
  actor?: string;
};

/**
 * Discovery inside a peer's own credentials POST or PUT: one try, 5 s. The peer waits
 * for our answer, so a slow or hanging versions endpoint must not hold the request.
 */
export const INBOUND_DISCOVERY: ClientOptions = {
  retries: 0,
  timeoutMs: 5_000,
};

type Discovery = {
  versionsUrl: string;
  version: string;
  endpoints: Endpoint[];
};

/** GET a peer's versions and the 2.2.1 version details; the credentials endpoint must exist. */
export async function discover(
  versionsUrl: string,
  token: string,
  correlationId: string,
  client?: ClientOptions,
): Promise<Discovery> {
  const fail = (e: unknown, what: string): never => {
    if (e instanceof HandshakeError) throw e;
    throw new HandshakeError(
      `Could not read the peer's ${what}: ${e instanceof Error ? e.message : "unknown error"}`,
    );
  };
  let versionsData: unknown;
  try {
    versionsData = (
      await ocpiRequest({ url: versionsUrl, token, correlationId }, client)
    ).data;
  } catch (e) {
    fail(e, "versions");
  }
  const versions = parseVersions(versionsData);
  if (!versions.ok)
    throw new HandshakeError(
      `The peer's versions are invalid: ${versions.errors.join("; ")}`,
    );
  const match = versions.value.find((v) => v.version === OCPI_VERSION);
  if (!match)
    throw new HandshakeError(
      `The peer does not offer OCPI ${OCPI_VERSION} (it offers ${versions.value.map((v) => v.version).join(", ")})`,
      STATUS.UNSUPPORTED_VERSION,
    );
  let detailsData: unknown;
  try {
    detailsData = (
      await ocpiRequest({ url: match.url, token, correlationId }, client)
    ).data;
  } catch (e) {
    fail(e, "version details");
  }
  const details = parseVersionDetails(detailsData);
  if (!details.ok)
    throw new HandshakeError(
      `The peer's version details are invalid: ${details.errors.join("; ")}`,
    );
  if (details.value.version !== OCPI_VERSION)
    throw new HandshakeError(
      `The peer's version details are for ${details.value.version}, not ${OCPI_VERSION}`,
      STATUS.UNSUPPORTED_VERSION,
    );
  if (!credentialsEndpoint(details.value.endpoints))
    throw new HandshakeError(
      "The peer has no credentials endpoint",
      STATUS.NO_MATCHING_ENDPOINTS,
    );
  return {
    versionsUrl,
    version: OCPI_VERSION,
    endpoints: details.value.endpoints,
  };
}

export function credentialsEndpoint(endpoints: Endpoint[]): string | undefined {
  // Platforms list credentials as SENDER, RECEIVER or both; either works.
  return endpoints.find((e) => e.identifier === "credentials")?.url;
}

/**
 * A peer's roles must include a CPO, must not be this eMSP, and must not belong to
 * another peer that is registered or registering.
 */
async function checkRoles(
  store: PeerStore,
  roles: CredentialsRole[],
  peerId: string,
): Promise<void> {
  if (!roles.some((r) => r.role === "CPO"))
    throw new HandshakeError(
      "The peer has no CPO role: this eMSP connects to CPOs",
      STATUS.CLIENT_ERROR,
    );
  const party = (r: CredentialsRole) => ({
    countryCode: r.country_code,
    partyId: r.party_id,
  });
  if (roles.some((r) => sameParty(party(r), ourParty())))
    throw new HandshakeError(
      "The peer uses this eMSP's own country code and party ID",
      STATUS.CLIENT_ERROR,
    );
  const others = (await store.listPeers()).filter(
    (p) => p.id !== peerId && p.status === "registered",
  );
  for (const r of roles)
    for (const other of others)
      if (other.roles.some((o) => sameParty(party(o), party(r))))
        throw new HandshakeError(
          `Party ${r.country_code}-${r.party_id} is already registered by another peer`,
          STATUS.CLIENT_ERROR,
        );
}

/** For the audit log and the admin web: who the peer is, no secrets. */
const partiesOf = (roles: CredentialsRole[]) =>
  roles.map((r) => `${r.role}:${r.country_code}-${r.party_id}`);

/** Our credentials response from a peer, validated. */
function credentialsFrom(data: unknown): Credentials {
  const parsed = parseCredentials(data);
  if (!parsed.ok)
    throw new HandshakeError(
      `The peer returned invalid credentials: ${parsed.errors.join("; ")}`,
    );
  return parsed.value;
}

/**
 * Registers this eMSP at a CPO, from the CPO's versions URL and the Token A it gave us.
 * Returns the registered peer. Refused in demo mode.
 */
export async function connectToCpo(
  input: { label: string; versionsUrl: string; tokenA: string },
  deps: HandshakeDeps,
): Promise<Peer> {
  assertLive("register at a CPO");
  const { store, client } = deps;
  const actor = deps.actor ?? "admin";
  const label = input.label.trim();
  if (!label || label.length > 100)
    throw new HandshakeError("Name must be 1 to 100 characters");
  let versionsUrl: URL;
  try {
    versionsUrl = new URL(input.versionsUrl.trim());
  } catch {
    throw new HandshakeError("Versions URL is not a URL");
  }
  if (
    versionsUrl.protocol !== "https:" ||
    versionsUrl.username ||
    versionsUrl.href.length > 255
  )
    throw new HandshakeError(
      "Versions URL must be an https:// URL of at most 255 characters",
    );
  const tokenA = input.tokenA.trim();
  if (!TOKEN_PATTERN.test(tokenA))
    throw new HandshakeError("Token A must be 1 to 64 printable characters");

  const correlationId = randomUUID();
  const first = await discover(versionsUrl.href, tokenA, correlationId, client);

  const peer = await store.createPeer({
    label,
    direction: "outbound",
    versionsUrl: versionsUrl.href,
  });
  const tokenB = generateToken();
  const hashB = hashToken(tokenB);
  // The CPO calls our versions endpoint with B before it answers the POST.
  await store.issueToken({ hash: hashB, peerId: peer.id, scope: "full" });

  let theirs: Credentials;
  try {
    const res = await ocpiRequest(
      {
        method: "POST",
        url: credentialsEndpoint(first.endpoints)!,
        token: tokenA,
        body: ourCredentials(tokenB),
        correlationId,
      },
      client,
    );
    theirs = credentialsFrom(res.data);
  } catch (e) {
    await giveUp(store, peer.id, actor, correlationId, e);
    throw asHandshakeError(e, "Registration at the CPO failed");
  }

  // From here on the CPO has us registered: if we cannot finish, unregister there.
  try {
    await checkRoles(store, theirs.roles, peer.id);
    // Token C replaces Token A; read the versions again with it, from the URL the CPO
    // returned, so the endpoints are the ones C is valid for.
    const final = await discover(
      theirs.url,
      theirs.token,
      correlationId,
      client,
    );
    const registered = await store.updatePeer(
      peer.id,
      {
        status: "registered",
        versionsUrl: final.versionsUrl,
        version: final.version,
        roles: theirs.roles,
        endpoints: final.endpoints,
        tokenCiphertext: encryptToken(theirs.token, peer.id),
        registeredAt: new Date().toISOString(),
      },
      "pending",
    );
    if (!registered)
      throw new HandshakeError("The peer changed during registration");
    await store.audit({
      actor,
      action: "ocpi.peer.registered",
      subjectId: peer.id,
      requestId: correlationId,
      details: { direction: "outbound", parties: partiesOf(theirs.roles) },
    });
    return registered;
  } catch (e) {
    const endpoint = credentialsEndpoint(first.endpoints)!;
    await ocpiRequest(
      { method: "DELETE", url: endpoint, token: theirs.token, correlationId },
      client,
    ).catch(() => undefined);
    await giveUp(store, peer.id, actor, correlationId, e);
    throw asHandshakeError(e, "Registration at the CPO failed");
  }
}

function asHandshakeError(e: unknown, prefix: string): HandshakeError {
  if (e instanceof HandshakeError) return e;
  if (e instanceof OcpiError)
    return new HandshakeError(`${prefix}: ${e.message}`);
  if (e instanceof Error && "code" in e && e.code === "demo_mode")
    return new HandshakeError(e.message);
  return new HandshakeError(`${prefix}: unexpected error`);
}

async function giveUp(
  store: PeerStore,
  peerId: string,
  actor: string,
  correlationId: string,
  e: unknown,
) {
  await store.revokePeerTokens(peerId);
  await store.updatePeer(peerId, { status: "failed" }, "pending");
  await store.audit({
    actor,
    action: "ocpi.peer.registration_failed",
    subjectId: peerId,
    requestId: correlationId,
    details: { error: e instanceof Error ? e.name : "unknown" },
  });
}

/**
 * Starts a registration by a CPO: a pending peer and its Token A. Hand the token and
 * our versions URL to the CPO; the token is shown only here, and only its hash is kept.
 */
export async function invitePeer(
  input: { label: string },
  deps: HandshakeDeps,
): Promise<{
  peer: Peer;
  tokenA: string;
  versionsUrl: string;
  expiresAt: string;
}> {
  const label = input.label.trim();
  if (!label || label.length > 100)
    throw new HandshakeError("Name must be 1 to 100 characters");
  const peer = await deps.store.createPeer({ label, direction: "inbound" });
  const tokenA = generateToken();
  const expiresAt = new Date(
    Date.now() + config.tokenATtlDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  await deps.store.issueToken({
    hash: hashToken(tokenA),
    peerId: peer.id,
    scope: "registration",
    expiresAt,
  });
  await deps.store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.peer.invited",
    subjectId: peer.id,
    details: { expiresAt },
  });
  return { peer, tokenA, versionsUrl: ocpiUrls().versions, expiresAt };
}

/** A peer's credentials body, validated, or a 400 for the peer. */
async function incomingCredentials(ctx: OcpiContext): Promise<Credentials> {
  const parsed = parseCredentials(await readJson(ctx.request));
  if (!parsed.ok)
    throw new OcpiProblem(
      400,
      STATUS.INVALID_PARAMETERS,
      `Invalid credentials: ${parsed.errors.join("; ")}`,
    );
  return parsed.value;
}

/**
 * Reads the versions of a peer that is calling us, from the URL it sent. Whatever goes
 * wrong, the peer gets one generic answer: never the remote server's status, message or
 * body, so the credentials module cannot be used to probe other hosts. The details are
 * logged here, without tokens.
 */
async function discoverCaller(
  ctx: OcpiContext,
  theirs: Credentials,
): Promise<Discovery> {
  try {
    return await discover(
      theirs.url,
      theirs.token,
      ctx.correlationId,
      INBOUND_DISCOVERY,
    );
  } catch (e) {
    console.warn(
      `OCPI credentials ${ctx.request.method} by peer ${ctx.peer.id} (request ${ctx.requestId}): discovery failed: ${e instanceof Error ? e.message : "unknown error"}`,
    );
    throw new OcpiProblem(
      400,
      STATUS.UNABLE_TO_USE_CLIENT_API,
      "Peer endpoint unreachable or invalid",
    );
  }
}

/** Turns a HandshakeError into the OCPI reply for a peer-started handshake. */
function toProblem(e: unknown): never {
  if (e instanceof HandshakeError)
    throw new OcpiProblem(400, e.statusCode, e.message);
  throw e;
}

const notAllowed = (message: string) =>
  new OcpiProblem(405, STATUS.CLIENT_ERROR, message);

/** GET credentials: our credentials, with the token the peer called us with. */
export async function getCredentials(ctx: OcpiContext): Promise<Response> {
  return ocpiResponse(ourCredentials(ctx.tokenValue), ctx);
}

/** POST credentials: a CPO registers with us, authorised with the Token A we issued. */
export async function postCredentials(ctx: OcpiContext): Promise<Response> {
  const { store, peer, token } = ctx;
  if (peer.status !== "pending" || token.scope !== "registration")
    throw notAllowed(
      "Already registered: use PUT to update or DELETE to unregister",
    );
  const theirs = await incomingCredentials(ctx);
  try {
    await checkRoles(store, theirs.roles, peer.id);
  } catch (e) {
    toProblem(e);
  }
  const found = await discoverCaller(ctx, theirs);

  const tokenC = generateToken();
  const hashC = hashToken(tokenC);
  await store.issueToken({ hash: hashC, peerId: peer.id, scope: "full" });
  const registered = await store.updatePeer(
    peer.id,
    {
      status: "registered",
      versionsUrl: found.versionsUrl,
      version: found.version,
      roles: theirs.roles,
      endpoints: found.endpoints,
      tokenCiphertext: encryptToken(theirs.token, peer.id),
      registeredAt: new Date().toISOString(),
    },
    "pending",
  );
  if (!registered) {
    await store.revokeToken(hashC);
    throw notAllowed("Already registered");
  }
  // Token A is single-use.
  await store.revokePeerTokens(peer.id, hashC);
  await store.audit({
    actor: `peer:${peer.id}`,
    action: "ocpi.peer.registered",
    subjectId: peer.id,
    requestId: ctx.requestId,
    details: { direction: "inbound", parties: partiesOf(theirs.roles) },
  });
  return ocpiResponse(ourCredentials(tokenC), ctx);
}

/** PUT credentials: a registered CPO gives us a new token and gets a new one back. */
export async function putCredentials(ctx: OcpiContext): Promise<Response> {
  const { store, peer, token } = ctx;
  if (peer.status !== "registered" || token.scope !== "full")
    throw notAllowed("Not registered: use POST to register");
  const theirs = await incomingCredentials(ctx);
  try {
    await checkRoles(store, theirs.roles, peer.id);
  } catch (e) {
    toProblem(e);
  }
  const found = await discoverCaller(ctx, theirs);

  const tokenC = generateToken();
  const hashC = hashToken(tokenC);
  await store.issueToken({ hash: hashC, peerId: peer.id, scope: "full" });
  const updated = await store.updatePeer(
    peer.id,
    {
      versionsUrl: found.versionsUrl,
      version: found.version,
      roles: theirs.roles,
      endpoints: found.endpoints,
      tokenCiphertext: encryptToken(theirs.token, peer.id),
    },
    "registered",
  );
  if (!updated) {
    await store.revokeToken(hashC);
    throw notAllowed("Not registered");
  }
  // The token this request came with, and any older one, stop working now.
  await store.revokePeerTokens(peer.id, hashC);
  await store.audit({
    actor: `peer:${peer.id}`,
    action: "ocpi.peer.credentials_updated",
    subjectId: peer.id,
    requestId: ctx.requestId,
    details: { parties: partiesOf(theirs.roles) },
  });
  return ocpiResponse(ourCredentials(tokenC), ctx);
}

/** DELETE credentials: a registered CPO unregisters. Its tokens stop working. */
export async function deleteCredentials(ctx: OcpiContext): Promise<Response> {
  const { store, peer, token } = ctx;
  if (peer.status !== "registered" || token.scope !== "full")
    throw notAllowed("Not registered");
  await markUnregistered(store, peer.id, "registered");
  await store.audit({
    actor: `peer:${peer.id}`,
    action: "ocpi.peer.unregistered",
    subjectId: peer.id,
    requestId: ctx.requestId,
    details: { by: "peer" },
  });
  return ocpiResponse(undefined, ctx);
}

async function markUnregistered(
  store: PeerStore,
  peerId: string,
  ifStatus: Peer["status"],
) {
  const done = await store.updatePeer(
    peerId,
    {
      status: "unregistered",
      tokenCiphertext: null,
      unregisteredAt: new Date().toISOString(),
    },
    ifStatus,
  );
  if (!done) throw notAllowed("Not registered");
  await store.revokePeerTokens(peerId);
}

async function registeredPeer(store: PeerStore, peerId: string) {
  const peer = await store.getPeer(peerId);
  if (!peer) throw new HandshakeError("No such peer");
  if (peer.status !== "registered" || !peer.tokenCiphertext)
    throw new HandshakeError(`The peer is ${peer.status}, not registered`);
  const endpoint = credentialsEndpoint(peer.endpoints);
  if (!endpoint)
    throw new HandshakeError("The peer has no credentials endpoint");
  return { peer, endpoint, token: decryptToken(peer.tokenCiphertext, peer.id) };
}

/**
 * Rotates the tokens with a registered CPO: PUT our credentials with a new token, and
 * store the new token it returns. Our old token keeps working until the CPO has
 * answered, so its calls during the PUT are not refused.
 */
export async function rotateCredentials(
  peerId: string,
  deps: HandshakeDeps,
): Promise<Peer> {
  assertLive("update credentials at a CPO");
  const { store, client } = deps;
  const { peer, endpoint, token } = await registeredPeer(store, peerId);
  const correlationId = randomUUID();
  const newB = generateToken();
  const hashB = hashToken(newB);
  await store.issueToken({ hash: hashB, peerId, scope: "full" });

  let theirs: Credentials;
  try {
    const res = await ocpiRequest(
      {
        method: "PUT",
        url: endpoint,
        token,
        body: ourCredentials(newB),
        correlationId,
      },
      client,
    );
    theirs = credentialsFrom(res.data);
  } catch (e) {
    await store.revokeToken(hashB);
    throw asHandshakeError(e, "Updating credentials at the CPO failed");
  }

  // The CPO now only knows newB, so store its new token whatever else happens. New
  // roles get the same checks as at registration; if they fail, the old ones stay.
  let roles = theirs.roles;
  let refused: HandshakeError | undefined;
  try {
    await checkRoles(store, theirs.roles, peerId);
  } catch (e) {
    refused = asHandshakeError(e, "The CPO's new roles were refused");
    roles = peer.roles;
  }
  let endpoints = peer.endpoints;
  let versionsUrl = peer.versionsUrl;
  try {
    const found = await discover(
      theirs.url,
      theirs.token,
      correlationId,
      client,
    );
    endpoints = found.endpoints;
    versionsUrl = found.versionsUrl;
  } catch {
    // Keep the endpoints we had; the next rotation reads them again.
  }
  const updated = await store.updatePeer(
    peerId,
    {
      tokenCiphertext: encryptToken(theirs.token, peerId),
      roles,
      endpoints,
      versionsUrl,
    },
    "registered",
  );
  await store.revokePeerTokens(peerId, hashB);
  await store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.peer.credentials_rotated",
    subjectId: peerId,
    requestId: correlationId,
    details: { parties: partiesOf(roles), rolesRefused: !!refused },
  });
  if (!updated) throw new HandshakeError("The peer changed during the update");
  if (refused)
    throw new HandshakeError(
      `Tokens rotated with ${updated.label}, but its new roles were refused and the old ones kept: ${refused.message}`,
    );
  return updated;
}

/**
 * Unregisters a peer. A registered CPO is told first (DELETE on its credentials
 * module); if it already forgot us (401 or 405), we unregister locally anyway. A pending
 * peer (an unused invitation, or a failed registration) is simply closed.
 */
export async function unregisterPeer(
  peerId: string,
  deps: HandshakeDeps,
): Promise<Peer> {
  const { store, client } = deps;
  const peer = await store.getPeer(peerId);
  if (!peer) throw new HandshakeError("No such peer");
  const correlationId = randomUUID();
  if (peer.status === "registered") {
    assertLive("unregister at a CPO");
    const { endpoint, token } = await registeredPeer(store, peerId);
    try {
      await ocpiRequest(
        { method: "DELETE", url: endpoint, token, correlationId },
        client,
      );
    } catch (e) {
      const gone =
        e instanceof OcpiUnauthorizedError ||
        (e instanceof OcpiError && e.httpStatus === 405);
      if (!gone) throw asHandshakeError(e, "Unregistering at the CPO failed");
    }
  } else if (peer.status !== "pending") {
    throw new HandshakeError(`The peer is already ${peer.status}`);
  }
  try {
    await markUnregistered(store, peerId, peer.status);
  } catch {
    throw new HandshakeError("The peer changed while unregistering");
  }
  await store.audit({
    actor: deps.actor ?? "admin",
    action: "ocpi.peer.unregistered",
    subjectId: peerId,
    requestId: correlationId,
    details: { by: "emsp" },
  });
  return (await store.getPeer(peerId))!;
}
