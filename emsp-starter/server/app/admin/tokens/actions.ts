"use server";

import { peerStore } from "@/lib/ocpi/registry";
import { asAdmin as gate, field } from "@/lib/server/admin-action";
import { isDemo } from "@/lib/server/demo";
import {
  addRfidCard,
  blockToken,
  createAppToken,
  isDriverTokenType,
  setWhitelist,
  TokenError,
  unblockToken,
  type TokenDeps,
  type TokenResult,
} from "@/lib/tokens/manage";
import {
  retryPendingPushes,
  tokenValid,
  type PushOutcome,
} from "@/lib/tokens/push";
import { tokenStore } from "@/lib/tokens/registry";
import type { DriverToken } from "@/lib/tokens/store";

/** A token as the admin web shows it. */
export type TokenSummary = {
  uid: string;
  type: DriverToken["type"];
  contractId: string;
  driverRef: string;
  status: DriverToken["status"];
  valid: boolean;
  whitelist: DriverToken["whitelist"];
  visualNumber: string | null;
  expiresAt: string | null;
  lastUpdated: string;
};

export type TokenActionState = {
  ok?: boolean;
  message?: string;
  tokens?: TokenSummary[];
  pushes?: PushOutcome[];
};

function summary(t: DriverToken): TokenSummary {
  return {
    uid: t.uid,
    type: t.type,
    contractId: t.contractId,
    driverRef: t.driverRef,
    status: t.status,
    valid: tokenValid(t),
    whitelist: t.whitelist,
    visualNumber: t.visualNumber,
    expiresAt: t.expiresAt,
    lastUpdated: t.lastUpdated,
  };
}

const deps = (): TokenDeps => ({
  tokens: tokenStore(),
  peers: peerStore(),
  actor: "admin",
});

function asAdmin(
  form: FormData,
  fn: () => Promise<TokenActionState>,
): Promise<TokenActionState> {
  return gate(form, fn, {
    shown: (e) => e instanceof TokenError,
    fallback: "Something went wrong. Look the driver up before trying again.",
    what: "token",
  });
}

/** What happened to the pushes, in one sentence. */
function pushed(pushes: PushOutcome[]): string {
  if (isDemo()) return "Demo mode: not pushed to any CPO.";
  if (!pushes.length)
    return "No registered CPO has a tokens Receiver; CPOs can pull it from our Tokens Sender.";
  const failed = pushes.filter((p) => !p.ok).length;
  return failed
    ? `Pushed to ${pushes.length - failed} of ${pushes.length} CPO(s); the others are queued and retried.`
    : `Pushed to ${pushes.length} CPO(s).`;
}

const done = (what: string, r: TokenResult): TokenActionState => ({
  ok: true,
  message: `${what} ${pushed(r.pushes)}`,
  tokens: [summary(r.token)],
  pushes: r.pushes,
});

/** A driver's app token, with a new contract ID. */
export async function createAppTokenAction(
  _prev: TokenActionState,
  form: FormData,
): Promise<TokenActionState> {
  return asAdmin(form, async () =>
    done(
      "App token created.",
      await createAppToken(
        {
          driverRef: field(form, "driverRef"),
          whitelist: field(form, "whitelist"),
          language: field(form, "language"),
        },
        deps(),
      ),
    ),
  );
}

/** An RFID card for a driver with an app token. */
export async function addRfidCardAction(
  _prev: TokenActionState,
  form: FormData,
): Promise<TokenActionState> {
  return asAdmin(form, async () =>
    done(
      "Card added.",
      await addRfidCard(
        {
          driverRef: field(form, "driverRef"),
          uid: field(form, "uid"),
          visualNumber: field(form, "visualNumber"),
          expiresAt: field(form, "expiresAt"),
          whitelist: field(form, "whitelist"),
        },
        deps(),
      ),
    ),
  );
}

/** Block, unblock, or change the whitelist of one token. */
export async function changeTokenAction(
  _prev: TokenActionState,
  form: FormData,
): Promise<TokenActionState> {
  return asAdmin(form, async () => {
    const uid = field(form, "uid");
    const type = field(form, "type");
    if (!isDriverTokenType(type))
      return { ok: false, message: "Type must be APP_USER or RFID." };
    const intent = field(form, "intent");
    if (intent === "block")
      return done("Token blocked.", await blockToken(uid, type, deps()));
    if (intent === "unblock")
      return done("Token unblocked.", await unblockToken(uid, type, deps()));
    if (intent === "whitelist")
      return done(
        "Whitelist changed.",
        await setWhitelist(uid, type, field(form, "whitelist"), deps()),
      );
    return { ok: false, message: "Unknown action." };
  });
}

/** A driver's tokens. */
export async function driverTokensAction(
  _prev: TokenActionState,
  form: FormData,
): Promise<TokenActionState> {
  return asAdmin(form, async () => {
    const ref = field(form, "driverRef").trim();
    const tokens = (await tokenStore().listByDriver(ref)).map(summary);
    return {
      ok: true,
      message: tokens.length
        ? `${tokens.length} token(s).`
        : "No tokens for this driver.",
      tokens,
    };
  });
}

/** Sends the pushes CPOs missed that are due now. */
export async function retryPushesAction(
  _prev: TokenActionState,
  form: FormData,
): Promise<TokenActionState> {
  return asAdmin(form, async () => {
    if (isDemo())
      return { ok: true, message: "Demo mode: nothing is pushed to a CPO." };
    const d = deps();
    const r = await retryPendingPushes(d);
    const left = await d.tokens.countPendingPushes(1000);
    return {
      ok: true,
      message: `Sent ${r.sent}, failed ${r.failed}, dropped ${r.dropped} (peer gone). ${left >= 1000 ? "1,000 or more" : left} push(es) still queued.`,
    };
  });
}
