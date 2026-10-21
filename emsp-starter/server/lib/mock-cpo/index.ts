import "server-only";
import { ocpiPaginate, ocpiRequest, type Transport } from "@/lib/ocpi/client";
import { credentialsEndpoint } from "@/lib/ocpi/handshake";
import {
  parseCredentials,
  parseVersionDetails,
  parseVersions,
} from "@/lib/ocpi/schema";
import {
  COMMAND_TYPES,
  parseStartSession,
  parseStopSession,
  type CommandResponse,
  type CommandResultType,
  type StartSession,
  type StopSession,
} from "@/lib/ocpi/command-objects";
import type { EvseStatus, Location } from "@/lib/ocpi/locations";
import type { Tariff } from "@/lib/ocpi/tariffs";
import {
  parseAuthorizationInfo,
  parseToken,
  type LocationReferences,
  type Token,
  type TokenType,
} from "@/lib/ocpi/token-objects";
import { generateToken, tokensFromHeader } from "@/lib/ocpi/tokens";
import {
  ocpiTimestamp,
  STATUS,
  type Credentials,
  type Endpoint,
  type Party,
} from "@/lib/ocpi/types";
import {
  SAMPLE_SITE_COUNT,
  sampleLocations,
  sampleTariffs,
  type SampleOptions,
} from "./sample-data";

/**
 * The mock CPO: a second, generic OCPI 2.2.1 CPO platform that runs in-process. Tests
 * use it as a real peer, in both handshake directions, so the eMSP is never tested
 * against one platform only. It serves sample locations and tariffs (sample-data.ts,
 * also what demo mode shows) from paginated Sender interfaces with date_from and
 * date_to, and pushes changes to the eMSP's Receiver interfaces. Its Tokens Receiver
 * keeps the tokens the eMSP pushes (validated against 2.2.1), and it can pull the
 * eMSP's Tokens Sender and ask for real-time authorization. Its Commands Receiver
 * validates START_SESSION and STOP_SESSION against 2.2.1, answers with the
 * CommandResponse a test sets (or none at all), and POSTs any CommandResult to the
 * eMSP's response_url when a test asks. Later parts give it sessions and CDRs.
 *
 * `handle(request)` is the CPO's HTTP server. To reach the eMSP it uses `transport`
 * (in tests, an in-process router), never the network.
 */
export type MockCpoOptions = {
  /** How the mock CPO reaches the eMSP. */
  transport: Transport;
  baseUrl?: string;
  party?: Party;
  name?: string;
  /** Sample locations served by the paginated locations module. Default: one per sample site. */
  locationCount?: number;
  /** Most objects per page (X-Limit). Default 2. */
  pageLimit?: number;
  /** Where the sample sites are, their currency and so on. */
  sample?: SampleOptions;
};

export type RecordedRequest = {
  method: string;
  path: string;
  /** The token the request was authorised with, if any. */
  token?: string;
  headers: Record<string, string>;
};

export type ReceivedCommand =
  | {
      type: "START_SESSION";
      body: StartSession;
      headers: Record<string, string>;
    }
  | {
      type: "STOP_SESSION";
      body: StopSession;
      headers: Record<string, string>;
    };

export type MockCpo = ReturnType<typeof createMockCpo>;

export function createMockCpo(options: MockCpoOptions) {
  const baseUrl = (options.baseUrl ?? "https://mock-cpo.example.test").replace(
    /\/+$/,
    "",
  );
  const party = options.party ?? { countryCode: "ZZ", partyId: "MCK" };
  const name = options.name ?? "Mock CPO";
  const transport = options.transport;
  const urls = {
    versions: `${baseUrl}/ocpi/versions`,
    details: `${baseUrl}/ocpi/2.2.1`,
    credentials: `${baseUrl}/ocpi/2.2.1/credentials`,
    locations: `${baseUrl}/ocpi/2.2.1/locations`,
    tariffs: `${baseUrl}/ocpi/2.2.1/tariffs`,
    tokens: `${baseUrl}/ocpi/2.2.1/tokens`,
    commands: `${baseUrl}/ocpi/2.2.1/commands`,
  };
  const pageLimit = options.pageLimit ?? 2;

  const state = {
    /** Tokens A we handed out for an eMSP to register with. */
    tokensA: new Set<string>(),
    /** Tokens we issued that an eMSP calls us with (B or C, depending on direction). */
    issued: new Set<string>(),
    /** The eMSP we are registered with, and the token we call it with. */
    emsp: undefined as
      | { token: string; credentials: Credentials; endpoints: Endpoint[] }
      | undefined,
    requests: [] as RecordedRequest[],
    /** Injected failures: each entry answers one request. */
    faults: [] as ("hang" | number)[],
    /** What the Sender interfaces serve. Change freely in tests. */
    locations: sampleLocations(
      party,
      options.locationCount ?? SAMPLE_SITE_COUNT,
      options.sample,
    ),
    tariffs: sampleTariffs(party, options.sample),
    /** Tokens the eMSP pushed to our Tokens Receiver, by `cc/party/uid/type`. */
    tokens: new Map<string, Token>(),
    /** Commands the eMSP sent us, oldest first. */
    commands: [] as ReceivedCommand[],
    /**
     * How the Commands Receiver answers: a CommandResponse, or "hang" (no answer until
     * the eMSP gives up). With `resultFirst`, that CommandResult is POSTed to the
     * response_url before the CommandResponse goes back, as a fast charger can.
     */
    commandAnswer: { result: "ACCEPTED", timeout: 30 } as
      (CommandResponse & { resultFirst?: CommandResultType }) | "hang",
  };

  const credentialsFor = (token: string): Credentials => ({
    token,
    url: urls.versions,
    roles: [
      {
        role: "CPO",
        business_details: { name },
        party_id: party.partyId,
        country_code: party.countryCode,
      },
    ],
  });

  const reply = (
    data: unknown,
    {
      status = 200,
      code = STATUS.SUCCESS,
      message,
      headers,
    }: {
      status?: number;
      code?: number;
      message?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    Response.json(
      {
        ...(data === undefined ? {} : { data }),
        status_code: code,
        ...(message ? { status_message: message } : {}),
        timestamp: ocpiTimestamp(),
      },
      { status, headers },
    );
  const unauthorized = () =>
    reply(undefined, {
      status: 401,
      code: STATUS.CLIENT_ERROR,
      message: "Unauthorized",
    });
  const notAllowed = (message: string) =>
    reply(undefined, { status: 405, code: STATUS.CLIENT_ERROR, message });

  /** Reads an eMSP's versions and details with its token. */
  async function discoverEmsp(creds: Credentials) {
    const versions = parseVersions(
      (
        await ocpiRequest(
          { url: creds.url, token: creds.token },
          { transport, retries: 0 },
        )
      ).data,
    );
    const v = versions.ok && versions.value.find((x) => x.version === "2.2.1");
    if (!v) throw new Error("eMSP offers no 2.2.1");
    const details = parseVersionDetails(
      (
        await ocpiRequest(
          { url: v.url, token: creds.token },
          { transport, retries: 0 },
        )
      ).data,
    );
    if (!details.ok || !credentialsEndpoint(details.value.endpoints))
      throw new Error("eMSP has no credentials endpoint");
    return details.value.endpoints;
  }

  async function credentialsModule(request: Request, token: string) {
    const registered = state.issued.has(token) && state.emsp !== undefined;
    if (request.method === "GET") return reply(credentialsFor(token));
    if (request.method === "DELETE") {
      if (!registered) return notAllowed("Not registered");
      state.issued.clear();
      state.emsp = undefined;
      return reply(undefined);
    }
    if (request.method !== "POST" && request.method !== "PUT")
      return notAllowed("Method not allowed");
    if (request.method === "POST" && !state.tokensA.has(token))
      return notAllowed("Already registered");
    if (request.method === "PUT" && !registered)
      return notAllowed("Not registered");
    const parsed = parseCredentials(
      await request.json().catch(() => undefined),
    );
    if (!parsed.ok)
      return reply(undefined, {
        status: 400,
        code: STATUS.INVALID_PARAMETERS,
        message: parsed.errors.join("; "),
      });
    let endpoints: Endpoint[];
    try {
      endpoints = await discoverEmsp(parsed.value);
    } catch {
      return reply(undefined, {
        status: 400,
        code: STATUS.UNABLE_TO_USE_CLIENT_API,
        message: "Could not read the eMSP's versions",
      });
    }
    const tokenC = generateToken();
    state.tokensA.delete(token);
    state.issued.clear();
    state.issued.add(tokenC);
    state.emsp = {
      token: parsed.value.token,
      credentials: parsed.value,
      endpoints,
    };
    return reply(credentialsFor(tokenC));
  }

  /**
   * One page of a Sender interface: objects with last_updated in [date_from, date_to),
   * at most `pageLimit`, with X-Total-Count, X-Limit and a Link to the next page.
   */
  function senderPage(
    url: URL,
    base: string,
    all: { last_updated: string }[],
  ): Response {
    const q = url.searchParams;
    const from = q.get("date_from");
    const to = q.get("date_to");
    const list = all.filter(
      (o) =>
        (!from || Date.parse(o.last_updated) >= Date.parse(from)) &&
        (!to || Date.parse(o.last_updated) < Date.parse(to)),
    );
    const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
    const limit = Math.min(
      pageLimit,
      Math.max(1, Number(q.get("limit") ?? pageLimit) || pageLimit),
    );
    const headers: Record<string, string> = {
      "X-Total-Count": String(list.length),
      "X-Limit": String(pageLimit),
    };
    if (offset + limit < list.length) {
      const next = new URL(base);
      next.searchParams.set("offset", String(offset + limit));
      next.searchParams.set("limit", String(limit));
      if (from) next.searchParams.set("date_from", from);
      if (to) next.searchParams.set("date_to", to);
      headers.Link = `<${next}>; rel="next"`;
    }
    return reply(list.slice(offset, offset + limit), { headers });
  }

  /** The eMSP's endpoint for a module and role, from its version details. */
  function emspEndpoint(module: string, role: "SENDER" | "RECEIVER") {
    const url = state.emsp?.endpoints.find(
      (e) => e.identifier === module && e.role === role,
    )?.url;
    if (!url)
      throw new Error(
        `The eMSP has no ${module} ${role === "SENDER" ? "Sender" : "Receiver"} endpoint`,
      );
    return url;
  }
  const emspReceiver = (module: string) => emspEndpoint(module, "RECEIVER");

  /** Routing headers from us to the eMSP. */
  function toEmsp() {
    const role = state.emsp!.credentials.roles[0];
    return {
      from: party,
      to: { countryCode: role.country_code, partyId: role.party_id },
    };
  }

  /** Sends one push to the eMSP's Receiver interface, with routing headers. */
  async function push(
    module: "locations" | "tariffs",
    method: "PUT" | "PATCH" | "DELETE",
    path: string[],
    body?: unknown,
  ) {
    if (!state.emsp) throw new Error("Mock CPO is not registered with an eMSP");
    return ocpiRequest(
      {
        method,
        url: `${emspReceiver(module)}/${path.map(encodeURIComponent).join("/")}`,
        token: state.emsp.token,
        body,
        routing: toEmsp(),
      },
      { transport, retries: 0 },
    );
  }

  const findLocation = (id: string) => {
    const l = state.locations.find((x) => x.id === id);
    if (!l) throw new Error(`Mock CPO has no location ${id}`);
    return l;
  };
  const findEvse = (locationId: string, uid: string) => {
    const e = findLocation(locationId).evses?.find((x) => x.uid === uid);
    if (!e) throw new Error(`Mock CPO has no EVSE ${uid}`);
    return e;
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = tokensFromHeader(request.headers.get("Authorization"))[0];
    state.requests.push({
      method: request.method,
      path: url.pathname,
      token,
      headers: Object.fromEntries(request.headers),
    });

    const fault = state.faults.shift();
    if (fault === "hang")
      return new Promise((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        );
      });
    if (typeof fault === "number")
      return reply(undefined, {
        status: fault,
        code: STATUS.SERVER_ERROR,
        message: "Injected failure",
      });

    const known =
      token && (state.tokensA.has(token) || state.issued.has(token));
    if (!token || !known) return unauthorized();
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/ocpi/versions" && request.method === "GET")
      return reply([{ version: "2.2.1", url: urls.details }]);
    if (path === "/ocpi/2.2.1" && request.method === "GET")
      return reply({
        version: "2.2.1",
        endpoints: [
          { identifier: "credentials", role: "SENDER", url: urls.credentials },
          {
            identifier: "credentials",
            role: "RECEIVER",
            url: urls.credentials,
          },
          { identifier: "locations", role: "SENDER", url: urls.locations },
          { identifier: "tariffs", role: "SENDER", url: urls.tariffs },
          { identifier: "tokens", role: "RECEIVER", url: urls.tokens },
          { identifier: "commands", role: "RECEIVER", url: urls.commands },
        ],
      });
    if (path === "/ocpi/2.2.1/credentials")
      return credentialsModule(request, token);
    if (path === "/ocpi/2.2.1/locations" && request.method === "GET") {
      if (!state.issued.has(token)) return unauthorized();
      return senderPage(url, urls.locations, state.locations);
    }
    if (path === "/ocpi/2.2.1/tariffs" && request.method === "GET") {
      if (!state.issued.has(token)) return unauthorized();
      return senderPage(url, urls.tariffs, state.tariffs);
    }
    if (path.startsWith("/ocpi/2.2.1/tokens/")) {
      if (!state.issued.has(token)) return unauthorized();
      return tokensReceiver(request, url, path);
    }
    if (path.startsWith("/ocpi/2.2.1/commands/")) {
      if (!state.issued.has(token)) return unauthorized();
      return commandsReceiver(request, path);
    }
    return reply(undefined, {
      status: 404,
      code: STATUS.CLIENT_ERROR,
      message: "Not found",
    });
  }

  /**
   * Our Tokens Receiver: GET, PUT and PATCH
   * /ocpi/2.2.1/tokens/{country_code}/{party_id}/{uid}?type=. Pushed tokens must be
   * valid 2.2.1 Token objects that match the URL, and a PATCH must carry last_updated.
   */
  async function tokensReceiver(request: Request, url: URL, path: string) {
    const parts = path.split("/").slice(4).map(decodeURIComponent);
    const type = url.searchParams.get("type") ?? "RFID";
    if (parts.length !== 3)
      return reply(undefined, {
        status: 400,
        code: STATUS.INVALID_PARAMETERS,
        message: "Path must be /{country_code}/{party_id}/{uid}",
      });
    const [cc, pid, uid] = parts;
    const key = `${cc}/${pid}/${uid}/${type}`;
    const held = state.tokens.get(key);
    const invalid = (message: string) =>
      reply(undefined, {
        status: 400,
        code: STATUS.INVALID_PARAMETERS,
        message,
      });
    if (request.method === "GET")
      return held
        ? reply(held)
        : reply(undefined, {
            status: 404,
            code: STATUS.UNKNOWN_TOKEN,
            message: "Unknown token",
          });
    if (request.method !== "PUT" && request.method !== "PATCH")
      return notAllowed("Method not allowed");
    const body = await request.json().catch(() => undefined);
    if (request.method === "PATCH") {
      if (!held)
        return reply(undefined, {
          status: 404,
          code: STATUS.UNKNOWN_TOKEN,
          message: "Unknown token",
        });
      if (!body || typeof body !== "object" || !("last_updated" in body))
        return invalid("PATCH needs last_updated");
    }
    const parsed = parseToken(
      request.method === "PUT" ? body : { ...held, ...body },
    );
    if (!parsed.ok) return invalid(parsed.errors.join("; "));
    const t = parsed.value;
    if (
      t.country_code !== cc.toUpperCase() ||
      t.party_id !== pid.toUpperCase() ||
      t.uid !== uid ||
      t.type !== type
    )
      return invalid("Token does not match the URL");
    state.tokens.set(key, t);
    return reply(undefined);
  }

  /**
   * Our Commands Receiver: POST /ocpi/2.2.1/commands/{command}. START_SESSION and
   * STOP_SESSION must be valid 2.2.1 objects; other commands are NOT_SUPPORTED.
   */
  async function commandsReceiver(request: Request, path: string) {
    const type = path.split("/")[4];
    if (request.method !== "POST" || path.split("/").length !== 5)
      return notAllowed("Method not allowed");
    if (!(COMMAND_TYPES as readonly string[]).includes(type))
      return reply(undefined, {
        status: 404,
        code: STATUS.CLIENT_ERROR,
        message: "Unknown command",
      });
    if (type !== "START_SESSION" && type !== "STOP_SESSION")
      return reply({ result: "NOT_SUPPORTED", timeout: 0 });
    const body = await request.json().catch(() => undefined);
    const parsed =
      type === "START_SESSION"
        ? parseStartSession(body)
        : parseStopSession(body);
    if (!parsed.ok)
      return reply(undefined, {
        status: 400,
        code: STATUS.INVALID_PARAMETERS,
        message: parsed.errors.join("; "),
      });
    const received = {
      type,
      body: parsed.value,
      headers: Object.fromEntries(request.headers),
    } as ReceivedCommand;
    state.commands.push(received);
    const answer = state.commandAnswer;
    if (answer === "hang")
      return new Promise<Response>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () =>
          reject(request.signal.reason),
        );
      });
    const { resultFirst, ...response } = answer;
    if (resultFirst) await sendResult(received, resultFirst);
    return reply(response);
  }

  /** POSTs a CommandResult to a command's response_url. */
  async function sendResult(
    command: ReceivedCommand,
    result: CommandResultType,
    message?: { language: string; text: string }[],
  ) {
    if (!state.emsp) throw new Error("Mock CPO is not registered with an eMSP");
    return ocpiRequest(
      {
        method: "POST",
        url: command.body.response_url,
        token: state.emsp.token,
        body: message ? { result, message } : { result },
        routing: toEmsp(),
      },
      { transport, retries: 0 },
    );
  }

  /** The eMSP's credentials endpoint, from its version details. */
  function emspCredentialsUrl() {
    const url = state.emsp && credentialsEndpoint(state.emsp.endpoints);
    if (!url) throw new Error("Mock CPO is not registered with an eMSP");
    return url;
  }

  return {
    party,
    urls,
    state,
    handle,

    /** A Token A for an eMSP to register at this CPO with. */
    issueTokenA(): string {
      const t = generateToken();
      state.tokensA.add(t);
      return t;
    },

    /** The next `count` requests fail with HTTP `status` (or hang until aborted). */
    failNext(count: number, status: number | "hang" = 503) {
      for (let i = 0; i < count; i++) state.faults.push(status);
    },

    /** This CPO registers with an eMSP, using a Token A the eMSP issued. */
    async registerWith(versionsUrl: string, tokenA: string) {
      const endpoints = await discoverEmsp({
        token: tokenA,
        url: versionsUrl,
        roles: [],
      });
      const tokenB = generateToken();
      state.issued.add(tokenB);
      const res = await ocpiRequest(
        {
          method: "POST",
          url: credentialsEndpoint(endpoints)!,
          token: tokenA,
          body: credentialsFor(tokenB),
        },
        { transport, retries: 0 },
      );
      const parsed = parseCredentials(res.data);
      if (!parsed.ok) throw new Error("eMSP returned invalid credentials");
      state.emsp = {
        token: parsed.value.token,
        credentials: parsed.value,
        endpoints,
      };
      return parsed.value;
    },

    /** This CPO rotates tokens with the eMSP it is registered with (credentials PUT). */
    async updateCredentials() {
      const newB = generateToken();
      const old = [...state.issued];
      state.issued.add(newB);
      const res = await ocpiRequest(
        {
          method: "PUT",
          url: emspCredentialsUrl(),
          token: state.emsp!.token,
          body: credentialsFor(newB),
        },
        { transport, retries: 0 },
      );
      const parsed = parseCredentials(res.data);
      if (!parsed.ok) throw new Error("eMSP returned invalid credentials");
      for (const t of old) state.issued.delete(t);
      state.emsp = {
        ...state.emsp!,
        token: parsed.value.token,
        credentials: parsed.value,
      };
      return parsed.value;
    },

    /**
     * Changes an EVSE's status (REMOVED to take it away), moving last_updated of the
     * EVSE and its location. With `push`, PATCHes the eMSP's Receiver too.
     */
    async setEvseStatus(
      locationId: string,
      uid: string,
      status: EvseStatus,
      { push: send = false, at = new Date() } = {},
    ) {
      const location = findLocation(locationId);
      const evse = findEvse(locationId, uid);
      const last_updated = ocpiTimestamp(at);
      evse.status = status;
      evse.last_updated = last_updated;
      location.last_updated = last_updated;
      if (send)
        await push(
          "locations",
          "PATCH",
          [party.countryCode, party.partyId, locationId, uid],
          { status, last_updated },
        );
    },

    /** Adds or replaces a location here, and with `push` PUTs it to the eMSP. */
    async putLocation(location: Location, { push: send = false } = {}) {
      const i = state.locations.findIndex((x) => x.id === location.id);
      if (i >= 0) state.locations[i] = location;
      else state.locations.push(location);
      if (send)
        await push(
          "locations",
          "PUT",
          [location.country_code, location.party_id, location.id],
          location,
        );
    },

    /** Adds or replaces a tariff here, and with `push` PUTs it to the eMSP. */
    async putTariff(tariff: Tariff, { push: send = false } = {}) {
      const i = state.tariffs.findIndex((x) => x.id === tariff.id);
      if (i >= 0) state.tariffs[i] = tariff;
      else state.tariffs.push(tariff);
      if (send)
        await push(
          "tariffs",
          "PUT",
          [tariff.country_code, tariff.party_id, tariff.id],
          tariff,
        );
    },

    /** Removes a tariff here, and with `push` DELETEs it at the eMSP. */
    async deleteTariff(id: string, { push: send = false } = {}) {
      state.tariffs = state.tariffs.filter((t) => t.id !== id);
      if (send)
        await push("tariffs", "DELETE", [party.countryCode, party.partyId, id]);
    },

    /** A raw push, for tests of what the eMSP refuses. */
    push,

    /** How the Commands Receiver answers from now on. */
    answerCommands(answer: (typeof state)["commandAnswer"]) {
      state.commandAnswer = answer;
    },

    /** POSTs a CommandResult for a command we received (default: the last one). */
    sendCommandResult(
      result: CommandResultType,
      {
        command = state.commands.at(-1),
        message,
      }: {
        command?: ReceivedCommand;
        message?: { language: string; text: string }[];
      } = {},
    ) {
      if (!command) throw new Error("Mock CPO received no command");
      return sendResult(command, result, message);
    },

    /** A token the eMSP pushed to us, if any. */
    pushedToken(
      uid: string,
      type: TokenType,
      owner: Party = toEmsp().to,
    ): Token | undefined {
      return state.tokens.get(
        `${owner.countryCode}/${owner.partyId}/${uid}/${type}`,
      );
    },

    /**
     * Pulls the eMSP's Tokens Sender, every page, as a CPO does to fill its whitelist.
     * Invalid tokens fail the pull.
     */
    async pullTokens({
      dateFrom,
      dateTo,
      limit,
    }: { dateFrom?: Date; dateTo?: Date; limit?: number } = {}) {
      if (!state.emsp)
        throw new Error("Mock CPO is not registered with an eMSP");
      const out: Token[] = [];
      for await (const item of ocpiPaginate(
        {
          url: emspEndpoint("tokens", "SENDER"),
          token: state.emsp.token,
          dateFrom,
          dateTo,
          limit,
          routing: toEmsp(),
        },
        { transport, retries: 0 },
      )) {
        const parsed = parseToken(item);
        if (!parsed.ok)
          throw new Error(`Invalid token: ${parsed.errors.join("; ")}`);
        out.push(parsed.value);
      }
      return out;
    },

    /**
     * Asks the eMSP whether a token may charge (real-time authorization), optionally
     * at a location. Returns the validated AuthorizationInfo.
     */
    async authorize(
      uid: string,
      {
        type = "RFID",
        location,
        body,
      }: {
        type?: TokenType;
        location?: LocationReferences;
        body?: unknown;
      } = {},
    ) {
      if (!state.emsp)
        throw new Error("Mock CPO is not registered with an eMSP");
      const res = await ocpiRequest(
        {
          method: "POST",
          url: `${emspEndpoint("tokens", "SENDER")}/${encodeURIComponent(uid)}/authorize`,
          query: { type },
          token: state.emsp.token,
          body: body ?? location,
          routing: toEmsp(),
        },
        { transport, retries: 0 },
      );
      const parsed = parseAuthorizationInfo(res.data);
      if (!parsed.ok)
        throw new Error(
          `Invalid AuthorizationInfo: ${parsed.errors.join("; ")}`,
        );
      return parsed.value;
    },

    /** This CPO unregisters from the eMSP (credentials DELETE). */
    async unregister() {
      await ocpiRequest(
        {
          method: "DELETE",
          url: emspCredentialsUrl(),
          token: state.emsp!.token,
        },
        { transport, retries: 0 },
      );
      state.issued.clear();
      state.emsp = undefined;
    },
  };
}
