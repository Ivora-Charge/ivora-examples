import "server-only";
import { locationStore } from "@/lib/locations/registry";
import { parseCommandResult } from "@/lib/ocpi/command-objects";
import { OcpiProblem } from "@/lib/ocpi/errors";
import { ocpiResponse, readJson, type OcpiContext } from "@/lib/ocpi/server";
import { sameParty, STATUS } from "@/lib/ocpi/types";
import { tokenStore } from "@/lib/tokens/registry";
import { applyCommandResult, type CommandDeps } from "./manage";
import { commandStore } from "./registry";

/**
 * Our Commands Sender interface (OCPI 2.2.1 section 13.2.1): the response_url of every
 * command we send. The CPO POSTs the CommandResult there once the charger has answered
 * (or not):
 *
 *   POST /ocpi/2.2.1/commands/{START_SESSION|STOP_SESSION}/{command id}
 *   body: CommandResult (result, optional message)
 *
 * Only the peer and CPO party (OCPI-from) the command went to may answer it; anything
 * else, and a command not yet sent, is `2000 Unknown command` (HTTP 404). An invalid
 * body is 2001. A result for a command that has already ended is acknowledged and
 * changes nothing (one we timed out records it as a late result).
 */
const PATH =
  /^\/ocpi\/2\.2\.1\/commands\/(START_SESSION|STOP_SESSION)\/([0-9a-f-]{36})$/i;

export function receiverDeps(ctx: OcpiContext): CommandDeps {
  return {
    commands: commandStore(),
    peers: ctx.store,
    tokens: tokenStore(),
    locations: locationStore(),
    actor: `peer:${ctx.peer.id}`,
  };
}

/** POST /ocpi/2.2.1/commands/{command}/{uid} */
export async function commandResultReceiver(
  ctx: OcpiContext,
  deps: CommandDeps = receiverDeps(ctx),
): Promise<Response> {
  if (ctx.request.method !== "POST")
    throw new OcpiProblem(405, STATUS.CLIENT_ERROR, "Method not allowed");
  const from = ctx.from;
  if (
    !from ||
    !ctx.peer.roles.some(
      (r) =>
        r.role === "CPO" &&
        sameParty({ countryCode: r.country_code, partyId: r.party_id }, from),
    )
  )
    throw new OcpiProblem(
      403,
      STATUS.CLIENT_ERROR,
      "Command results come from CPO parties only",
    );
  const path = new URL(ctx.request.url).pathname.replace(/\/+$/, "");
  const m = PATH.exec(path);
  const unknown = () =>
    new OcpiProblem(404, STATUS.CLIENT_ERROR, "Unknown command");
  if (!m) throw unknown();
  const parsed = parseCommandResult(await readJson(ctx.request));
  if (!parsed.ok)
    throw new OcpiProblem(
      400,
      STATUS.INVALID_PARAMETERS,
      `Invalid CommandResult: ${parsed.errors.slice(0, 10).join("; ")}`,
    );
  const c = await deps.commands.get(m[2].toLowerCase());
  if (
    !c ||
    c.peerId !== ctx.peer.id ||
    // The party the command went to: on a platform with several CPO parties behind
    // one token, one party cannot answer another's command.
    !sameParty({ countryCode: c.toCountryCode, partyId: c.toPartyId }, from) ||
    c.type !== m[1].toUpperCase() ||
    c.status === "claimed"
  )
    throw unknown();
  await applyCommandResult(c, parsed.value, deps);
  return ocpiResponse(undefined, ctx);
}
