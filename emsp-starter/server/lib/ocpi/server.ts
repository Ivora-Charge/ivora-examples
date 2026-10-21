import "server-only";
import { randomUUID } from "node:crypto";
import { BodyTooLargeError, readLimitedText } from "./body";
import { OcpiProblem } from "./errors";
import { ourParty } from "./identity";
import { peerStore } from "./registry";
import type { IssuedToken, Peer, PeerStore } from "./store";
import { hashToken, tokensFromHeader } from "./tokens";
import { ocpiTimestamp, sameParty, STATUS, type Party } from "./types";

/**
 * The OCPI server middleware. Wraps a route handler so that it only runs for a known
 * peer with a valid token, and answers in the OCPI envelope.
 *
 * - Authorization: `Token <base64>` (or the unencoded 2.1.1 form). The token's SHA-256
 *   must match an active token we issued; unknown peers get 401.
 * - `access: "registered"`: only a registered peer's full token. `"handshake"` also
 *   accepts a Token A and the token of a peer still mid-registration: for the versions
 *   and credentials modules.
 * - `routing: "required"`: the four OCPI-from/to headers must be present; "to" must be
 *   this eMSP and "from" one of the peer's roles. The versions and credentials modules
 *   do not use routing headers.
 * - Echoes X-Request-ID and X-Correlation-ID, generating them when missing.
 */
export type OcpiContext = {
  request: Request;
  peer: Peer;
  token: IssuedToken;
  /** The token the peer called us with. Secret: never log it. */
  tokenValue: string;
  requestId: string;
  correlationId: string;
  /** Routing headers, when the module uses them. */
  from?: Party;
  store: PeerStore;
};

export type OcpiHandler = (ctx: OcpiContext) => Promise<Response>;

export type OcpiRouteOptions = {
  access: "handshake" | "registered";
  routing: "none" | "required";
};

const ID = /^[\x21-\x7e]{1,255}$/;
/** The largest request body a peer may send. */
export const MAX_REQUEST_BYTES = 256 * 1024;

/** An OCPI response: the envelope, and the request and correlation IDs. */
export function ocpiResponse(
  data: unknown,
  ids: { requestId: string; correlationId: string },
  {
    httpStatus = 200,
    statusCode = STATUS.SUCCESS,
    message,
  }: { httpStatus?: number; statusCode?: number; message?: string } = {},
): Response {
  const body: Record<string, unknown> = {};
  if (data !== undefined) body.data = data;
  body.status_code = statusCode;
  if (message) body.status_message = message;
  body.timestamp = ocpiTimestamp();
  return Response.json(body, {
    status: httpStatus,
    headers: {
      "X-Request-ID": ids.requestId,
      "X-Correlation-ID": ids.correlationId,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Reads a JSON request body, at most 256 KB: a larger Content-Length is refused before
 * reading, and the stream is cut at the limit. Throws an OcpiProblem the peer sees.
 */
export async function readJson(request: Request): Promise<unknown> {
  let text: string;
  try {
    text = await readLimitedText(request, MAX_REQUEST_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError)
      throw new OcpiProblem(413, STATUS.CLIENT_ERROR, "Request body too large");
    throw new OcpiProblem(
      400,
      STATUS.INVALID_PARAMETERS,
      "Request body could not be read",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OcpiProblem(
      400,
      STATUS.INVALID_PARAMETERS,
      "Request body is not valid JSON",
    );
  }
}

function routingParty(h: Headers, side: "from" | "to"): Party | undefined {
  const countryCode = h.get(`OCPI-${side}-country-code`)?.trim();
  const partyId = h.get(`OCPI-${side}-party-id`)?.trim();
  if (
    !countryCode ||
    !partyId ||
    !/^[A-Za-z]{2}$/.test(countryCode) ||
    !/^[A-Za-z0-9]{3}$/.test(partyId)
  )
    return undefined;
  return {
    countryCode: countryCode.toUpperCase(),
    partyId: partyId.toUpperCase(),
  };
}

export function withOcpi(handler: OcpiHandler, options: OcpiRouteOptions) {
  return async function ocpiRoute(request: Request): Promise<Response> {
    const h = request.headers;
    const requestId = ID.test(h.get("X-Request-ID") ?? "")
      ? h.get("X-Request-ID")!
      : randomUUID();
    const correlationId = ID.test(h.get("X-Correlation-ID") ?? "")
      ? h.get("X-Correlation-ID")!
      : randomUUID();
    const ids = { requestId, correlationId };
    const problem = (p: OcpiProblem) =>
      ocpiResponse(undefined, ids, {
        httpStatus: p.httpStatus,
        statusCode: p.statusCode,
        message: p.message,
      });

    try {
      const store = peerStore();
      let token: IssuedToken | null = null;
      let tokenValue = "";
      for (const candidate of tokensFromHeader(h.get("Authorization"))) {
        token = await store.findToken(hashToken(candidate));
        if (token) {
          tokenValue = candidate;
          break;
        }
      }
      const peer = token ? await store.getPeer(token.peerId) : null;
      if (
        !token ||
        !peer ||
        peer.status === "unregistered" ||
        peer.status === "failed"
      )
        throw new OcpiProblem(
          401,
          STATUS.CLIENT_ERROR,
          "Unknown or invalid token",
        );
      if (
        options.access === "registered" &&
        (peer.status !== "registered" || token.scope !== "full")
      )
        throw new OcpiProblem(
          403,
          STATUS.CLIENT_ERROR,
          "Token is not valid for this module: complete the credentials registration first",
        );

      let from: Party | undefined;
      if (options.routing === "required") {
        from = routingParty(h, "from");
        const to = routingParty(h, "to");
        if (!from || !to)
          throw new OcpiProblem(
            400,
            STATUS.INVALID_PARAMETERS,
            "Missing or invalid OCPI-from/OCPI-to routing headers",
          );
        if (!sameParty(to, ourParty()))
          throw new OcpiProblem(
            400,
            STATUS.INVALID_PARAMETERS,
            "OCPI-to-country-code and OCPI-to-party-id do not match this eMSP",
          );
        if (
          !peer.roles.some((r) =>
            sameParty(
              { countryCode: r.country_code, partyId: r.party_id },
              from!,
            ),
          )
        )
          throw new OcpiProblem(
            403,
            STATUS.CLIENT_ERROR,
            "OCPI-from-country-code and OCPI-from-party-id are not a party of this token",
          );
      }

      const res = await handler({
        request,
        peer,
        token,
        tokenValue,
        requestId,
        correlationId,
        from,
        store,
      });
      res.headers.set("X-Request-ID", requestId);
      res.headers.set("X-Correlation-ID", correlationId);
      return res;
    } catch (e) {
      if (e instanceof OcpiProblem) return problem(e);
      // Name the error, not its details: they may include peer data.
      console.error(
        `OCPI ${request.method} ${new URL(request.url).pathname} failed (request ${requestId}): ${e instanceof Error ? e.name : "unknown error"}`,
      );
      return problem(
        new OcpiProblem(500, STATUS.SERVER_ERROR, "Internal server error"),
      );
    }
  };
}
