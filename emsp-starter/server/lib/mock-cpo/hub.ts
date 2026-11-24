import "server-only";
import type { Transport } from "@/lib/ocpi/client";
import { ocpiTimestamp, STATUS, type Party } from "@/lib/ocpi/types";
import { createMockCpo, type MockCpo, type MockCpoOptions } from "./index";

/**
 * A mock roaming hub: a generic OCPI 2.2.1 hub that runs in-process, for tests and
 * local dry runs. It registers like any platform (credentials with a HUB role) and
 * connects the eMSP to several mock CPOs ("parties"). Whatever the eMSP sends to a
 * module, the hub forwards by the OCPI-to-country-code and OCPI-to-party-id headers to
 * that party's mock CPO; an unknown party gets a hub error (4001). Each party's mock CPO
 * pushes to the eMSP through the hub's connection, with its own OCPI-from party. The
 * hub lists its parties in a hubclientinfo Sender.
 *
 * Which parties the eMSP trusts is the eMSP operator's choice, not the hub's: the
 * hub connects them all.
 */
export type MockHubOptions = {
  transport: Transport;
  baseUrl?: string;
  /** The hub's own party. Test data: choose any. */
  party?: Party;
  name?: string;
  /** The CPO parties behind the hub, each with its own sample data. */
  parties: { party: Party; name?: string; sample?: MockCpoOptions["sample"] }[];
  pageLimit?: number;
};

export type MockHub = ReturnType<typeof createMockHub>;

const header = (r: Request, side: "from" | "to"): Party | undefined => {
  const countryCode = r.headers.get(`OCPI-${side}-country-code`);
  const partyId = r.headers.get(`OCPI-${side}-party-id`);
  return countryCode && partyId
    ? { countryCode: countryCode.toUpperCase(), partyId: partyId.toUpperCase() }
    : undefined;
};

export function createMockHub(options: MockHubOptions) {
  const baseUrl = (options.baseUrl ?? "https://mock-hub.example.test").replace(
    /\/+$/,
    "",
  );
  const hubParty = options.party ?? { countryCode: "ZZ", partyId: "HUB" };
  const children = new Map<string, MockCpo>();
  const key = (p: Party) => `${p.countryCode}-${p.partyId}`.toUpperCase();
  /** The parties the hubclientinfo Sender lists. Change freely in tests. */
  const listed: { party: Party; status: string; role: string }[] = [];
  /** Requests the hub could not route (unknown OCPI-to party). */
  const unroutable: string[] = [];

  const reply = (
    data: unknown,
    code: number = STATUS.SUCCESS,
    message?: string,
  ) =>
    Response.json({
      ...(data === undefined ? {} : { data }),
      status_code: code,
      ...(message ? { status_message: message } : {}),
      timestamp: ocpiTimestamp(),
    });

  const hub: MockCpo = createMockCpo({
    transport: options.transport,
    baseUrl,
    party: hubParty,
    name: options.name ?? "Mock Hub",
    role: "HUB",
    locationCount: 0,
    pageLimit: options.pageLimit,
    extraEndpoints: [
      {
        identifier: "hubclientinfo",
        role: "SENDER",
        url: `${baseUrl}/ocpi/2.2.1/hubclientinfo`,
      },
    ],
    async intercept(request, url, token) {
      if (!hub.state.issued.has(token))
        return Response.json(
          {
            status_code: STATUS.CLIENT_ERROR,
            status_message: "Unauthorized",
            timestamp: ocpiTimestamp(),
          },
          { status: 401 },
        );
      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/ocpi/2.2.1/hubclientinfo" && request.method === "GET")
        return reply(
          listed.map((l) => ({
            party_id: l.party.partyId,
            country_code: l.party.countryCode,
            role: l.role,
            status: l.status,
            last_updated: ocpiTimestamp(),
          })),
        );
      const to = header(request, "to");
      // A token push addressed to the hub's own party: the hub accepts it (what it does
      // with it is its own business; the request is in hub.state.requests).
      if (
        to &&
        key(to) === key(hubParty) &&
        path.startsWith("/ocpi/2.2.1/tokens/") &&
        (request.method === "PUT" || request.method === "PATCH")
      )
        return reply(undefined);
      const child = to && children.get(key(to));
      if (!child) {
        unroutable.push(`${request.method} ${path}`);
        return reply(undefined, STATUS.UNKNOWN_RECEIVER, "Unknown receiver");
      }
      // The party's platform answers with the hub's connection to the eMSP.
      child.state.issued.clear();
      for (const t of hub.state.issued) child.state.issued.add(t);
      child.state.emsp = hub.state.emsp;
      return child.handle(request);
    },
  });

  for (const p of options.parties) {
    const cpo = createMockCpo({
      transport: options.transport,
      baseUrl,
      party: p.party,
      name: p.name ?? `Mock CPO ${key(p.party)}`,
      pageLimit: options.pageLimit,
      sample: p.sample,
    });
    children.set(key(p.party), cpo);
    listed.push({ party: p.party, status: "CONNECTED", role: "CPO" });
  }

  /** Makes the parties' connection to the eMSP the hub's own (after the handshake). */
  const connect = () => {
    for (const child of children.values()) {
      child.state.issued.clear();
      for (const t of hub.state.issued) child.state.issued.add(t);
      child.state.emsp = hub.state.emsp;
    }
  };

  return {
    ...hub,
    hub,
    hubParty,
    listed,
    unroutable,
    /** The mock CPO of a party behind the hub. */
    cpo(party: Party): MockCpo {
      const c = children.get(key(party));
      if (!c) throw new Error(`Mock hub has no party ${key(party)}`);
      return c;
    },
    /** Call after the eMSP and the hub registered: parties can now push. */
    connect,
    /** Adds a party behind the hub after creation. */
    addParty(p: MockHubOptions["parties"][number]) {
      children.set(
        key(p.party),
        createMockCpo({
          transport: options.transport,
          baseUrl,
          party: p.party,
          name: p.name ?? `Mock CPO ${key(p.party)}`,
          pageLimit: options.pageLimit,
          sample: p.sample,
        }),
      );
      listed.push({ party: p.party, status: "CONNECTED", role: "CPO" });
      connect();
    },
  };
}
