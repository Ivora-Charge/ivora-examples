import { displayTexts, int, oneOf, type DisplayText } from "./locations";
import {
  done,
  object,
  optional,
  str,
  url,
  type Ctx,
  type Parsed,
} from "./schema";
import { parseToken, type Token } from "./token-objects";

/**
 * OCPI 2.2.1 Commands module objects (section 13): the StartSession and StopSession
 * requests an eMSP sends to a CPO's Commands Receiver, the CommandResponse the CPO
 * answers with at once, and the CommandResult it later POSTs to our response_url. Like
 * schema.ts, a validator returns the object with only the fields the spec defines, or
 * a list of problems that name fields, never values.
 */

export const COMMAND_TYPES = [
  "CANCEL_RESERVATION",
  "RESERVE_NOW",
  "START_SESSION",
  "STOP_SESSION",
  "UNLOCK_CONNECTOR",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** The CPO's synchronous answer: whether it will forward the command (section 13.4.2). */
export const COMMAND_RESPONSE_TYPES = [
  "NOT_SUPPORTED",
  "REJECTED",
  "ACCEPTED",
  "UNKNOWN_SESSION",
] as const;
export type CommandResponseType = (typeof COMMAND_RESPONSE_TYPES)[number];

/** What the charger did, sent later to our response_url (section 13.4.3). */
export const COMMAND_RESULT_TYPES = [
  "ACCEPTED",
  "CANCELED_RESERVATION",
  "EVSE_OCCUPIED",
  "EVSE_INOPERATIVE",
  "FAILED",
  "NOT_SUPPORTED",
  "REJECTED",
  "TIMEOUT",
  "UNKNOWN_RESERVATION",
] as const;
export type CommandResultType = (typeof COMMAND_RESULT_TYPES)[number];

export type CommandResponse = {
  result: CommandResponseType;
  /** Seconds the CPO waits for the charger before it sends a CommandResult TIMEOUT. */
  timeout: number;
  message?: DisplayText[];
};

export type CommandResult = {
  result: CommandResultType;
  message?: DisplayText[];
};

export type StartSession = {
  response_url: string;
  token: Token;
  location_id: string;
  /** Required when connector_id is set. */
  evse_uid?: string;
  connector_id?: string;
  authorization_reference?: string;
};

export type StopSession = { response_url: string; session_id: string };

/** CiString(36): printable ASCII. */
const ID = /^[\x20-\x7e]+$/;

function messages(ctx: Ctx, v: unknown, path: string) {
  return optional(v, (x) => displayTexts(ctx, x, path));
}

/** The CPO's CommandResponse, as we receive it. */
export function parseCommandResponse(v: unknown): Parsed<CommandResponse> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "command_response");
  if (!o) return { ok: false, errors: ctx.errors };
  const result = oneOf(
    ctx,
    o.result,
    "command_response.result",
    COMMAND_RESPONSE_TYPES,
  );
  const timeout = int(ctx, o.timeout, "command_response.timeout", 0, 86_400);
  const message = messages(ctx, o.message, "command_response.message");
  if (!result || timeout === undefined)
    return done<CommandResponse>(ctx, undefined);
  return done(
    ctx,
    message ? { result, timeout, message } : { result, timeout },
  );
}

/** The CommandResult a CPO POSTs to our response_url. */
export function parseCommandResult(v: unknown): Parsed<CommandResult> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "command_result");
  if (!o) return { ok: false, errors: ctx.errors };
  const result = oneOf(
    ctx,
    o.result,
    "command_result.result",
    COMMAND_RESULT_TYPES,
  );
  const message = messages(ctx, o.message, "command_result.message");
  if (!result) return done<CommandResult>(ctx, undefined);
  return done(ctx, message ? { result, message } : { result });
}

/** A StartSession as a CPO receives it: for the mock CPO and tests. */
export function parseStartSession(v: unknown): Parsed<StartSession> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "start_session");
  if (!o) return { ok: false, errors: ctx.errors };
  const response_url = url(ctx, o.response_url, "start_session.response_url", {
    httpsOnly: true,
  });
  const token = parseToken(o.token);
  if (!token.ok)
    ctx.errors.push(...token.errors.map((e) => `start_session.${e}`));
  const location_id = str(
    ctx,
    o.location_id,
    "start_session.location_id",
    36,
    ID,
  );
  const id = (x: unknown, p: string) => str(ctx, x, p, 36, ID);
  const evse_uid = optional(o.evse_uid, (x) => id(x, "start_session.evse_uid"));
  const connector_id = optional(o.connector_id, (x) =>
    id(x, "start_session.connector_id"),
  );
  const authorization_reference = optional(o.authorization_reference, (x) =>
    id(x, "start_session.authorization_reference"),
  );
  if (connector_id !== undefined && evse_uid === undefined)
    ctx.errors.push("start_session.evse_uid is required with connector_id");
  if (!response_url || !token.ok || !location_id)
    return done<StartSession>(ctx, undefined);
  const value: StartSession = {
    response_url,
    token: token.value,
    location_id,
  };
  if (evse_uid !== undefined) value.evse_uid = evse_uid;
  if (connector_id !== undefined) value.connector_id = connector_id;
  if (authorization_reference !== undefined)
    value.authorization_reference = authorization_reference;
  return done(ctx, value);
}

/** A StopSession as a CPO receives it: for the mock CPO and tests. */
export function parseStopSession(v: unknown): Parsed<StopSession> {
  const ctx: Ctx = { errors: [] };
  const o = object(ctx, v, "stop_session");
  if (!o) return { ok: false, errors: ctx.errors };
  const response_url = url(ctx, o.response_url, "stop_session.response_url", {
    httpsOnly: true,
  });
  const session_id = str(ctx, o.session_id, "stop_session.session_id", 36, ID);
  return done(
    ctx,
    response_url && session_id ? { response_url, session_id } : undefined,
  );
}
