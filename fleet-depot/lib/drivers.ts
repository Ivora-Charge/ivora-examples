import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { IvoraError, ivora, type Ivora } from "./ivora";
import { logEvent, type Depot } from "./depot";
import { parseRfidCsv, toIvoraImportCsv, TAG } from "./rfid";
import type { Driver } from "./types";

/** Our stable reference for a driver's card in Ivora, so retries find the same token. */
export const cardRef = (driverId: string) => `fd-driver-${driverId}`;

type Api = Pick<
  Ivora,
  "createToken" | "listTokens" | "updateToken" | "importTokens"
>;
const live = (d: Depot, api?: Api): Api | null =>
  d.demo ? null : (api ?? ivora());

export async function createDriver(
  d: Depot,
  input: { name: string; idTag?: string },
  api?: Api,
): Promise<Driver> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new UserError("name is required");
  const idTag = input.idTag?.trim() || undefined;
  if (idTag && !TAG.test(idTag))
    throw new UserError(
      "card value must be 1-20 letters, digits, '-' or '_' (OCPP 1.6 idTag)",
    );
  const drivers = await d.store.list("drivers");
  if (
    idTag &&
    drivers.some((p) => p.idTag?.toUpperCase() === idTag.toUpperCase())
  )
    throw new UserError("another driver already has this card");
  const drv: Driver = { id: randomUUID(), name, idTag, cardBlocked: false };
  // Store first: the driver ID is part of the token's external_reference and idempotency key.
  await d.store.put("drivers", drv.id, drv);
  const client = live(d, api);
  if (idTag && client) {
    try {
      const t = await client.createToken(
        { id_token: idTag, external_reference: cardRef(drv.id) },
        `fd-token-create-${drv.id}`,
      );
      drv.tokenId = t.id;
    } catch (e) {
      // The card is already registered in this tenant: adopt the existing token.
      const existing =
        e instanceof IvoraError && e.code === "token_exists"
          ? Number(e.details?.token_id)
          : NaN;
      if (!Number.isInteger(existing)) {
        drv.cardError = e instanceof IvoraError ? e.code : "error";
        await d.store.put("drivers", drv.id, drv);
        throw e;
      }
      drv.tokenId = existing;
    }
    await d.store.put("drivers", drv.id, drv);
  }
  await logEvent(d, "driver.created", name);
  return drv;
}

export interface ImportOutcome {
  imported: number;
  errors: { line?: number; row?: number; code?: string; message: string }[];
  counts?: Record<string, number>;
}

/** Import "idTag,driverName[,email]" rows: drivers locally, cards through POST .../tokens/import. */
export async function importDrivers(
  d: Depot,
  csv: string,
  api?: Api,
): Promise<ImportOutcome> {
  const { rows, errors } = parseRfidCsv(csv);
  const out: ImportOutcome = { imported: 0, errors: [...errors] };
  if (rows.length === 0) return out;
  const existing = await d.store.list("drivers");
  const batch: Driver[] = rows.map((r) => {
    // Re-importing the same card updates that driver instead of adding a second one.
    const prev = existing.find(
      (p) => p.idTag?.toUpperCase() === r.idTag.toUpperCase(),
    );
    return {
      ...(prev ?? { id: randomUUID(), cardBlocked: false }),
      name: r.driverName,
      email: r.email,
      idTag: r.idTag,
    };
  });
  for (const drv of batch) await d.store.put("drivers", drv.id, drv);

  const client = live(d, api);
  if (client) {
    const body = toIvoraImportCsv(
      batch.map((p) => ({ idTag: p.idTag!, externalReference: cardRef(p.id) })),
    );
    // The same file gives the same key; a changed file is a new import.
    const key = `fd-import-${createHash("sha256").update(body).digest("hex").slice(0, 40)}`;
    const res = await client.importTokens(body, key);
    out.counts = res.counts;
    for (const r of res.rows) {
      const drv = batch[r.row - 1];
      if (!drv) continue;
      if (r.action === "error") {
        drv.cardError = r.code ?? "error";
        out.errors.push({
          row: r.row,
          code: r.code ?? undefined,
          message: `${r.id_token ?? ""}: ${r.message ?? r.code ?? "refused"}`,
        });
      } else {
        drv.cardError = undefined;
        if (r.token_id) drv.tokenId = r.token_id;
      }
      await d.store.put("drivers", drv.id, drv);
    }
  }
  out.imported = batch.filter((p) => !p.cardError).length;
  await logEvent(
    d,
    "cards.imported",
    `${out.imported} imported, ${out.errors.length} rejected`,
  );
  return out;
}

/** Block a leaving driver's card. Looks the token up by ID, our reference, then value. */
export async function blockDriver(
  d: Depot,
  driverId: string,
  api?: Api,
): Promise<Driver> {
  const drv = (await d.store.list("drivers")).find((x) => x.id === driverId);
  if (!drv) throw new UserError("driver not found", 404);
  const client = live(d, api);
  if (drv.idTag && client) {
    let tokenId = drv.tokenId;
    if (tokenId === undefined) {
      const byRef = await client.listTokens({
        external_reference: cardRef(drv.id),
      });
      tokenId = byRef.data[0]?.id;
    }
    if (tokenId === undefined) {
      const byValue = await client.listTokens({ id_token: drv.idTag });
      tokenId = byValue.data.find(
        (t) => t.id_token.toUpperCase() === drv.idTag!.toUpperCase(),
      )?.id;
    }
    if (tokenId === undefined)
      throw new UserError("this card is not registered in Ivora", 404);
    await client.updateToken(
      tokenId,
      { status: "Blocked" },
      `fd-token-block-${tokenId}`,
    );
    drv.tokenId = tokenId;
  }
  drv.cardBlocked = true;
  await d.store.put("drivers", drv.id, drv);
  await logEvent(d, "card.blocked", drv.name);
  return drv;
}

export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
