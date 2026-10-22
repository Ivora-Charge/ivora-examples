import { isStickerCode } from "@/lib/sticker-codes";
import { getChargers } from "@/lib/server/chargers";
import { config, isDemo } from "@/lib/server/env";
import { connectorPricing, getPricing } from "@/lib/server/pricing";

export const metadata = { title: "Charge here" };

/**
 * Where a sticker's QR code lands, on your own domain. Public: drivers are not staff.
 * It is a placeholder until the kit's driver flow is connected; stickers keep working
 * because only this page decides where a code goes.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const normal = code.toUpperCase();
  const found = isStickerCode(normal)
    ? await getChargers().store.resolveCode(normal)
    : null;
  const pricing =
    found?.inService && found.stationId !== null
      ? await connectorPricing(
          getPricing().store,
          found.operatorId,
          found.stationId,
          found.connectorId,
        )
      : null;
  return (
    <section className="card" aria-labelledby="charge-heading">
      {isDemo() && (
        <p className="notice" role="note">
          Demo sticker: simulated charger.
        </p>
      )}
      <h1 id="charge-heading">Charge here</h1>
      {found?.inService ? (
        <>
          <p>
            <strong>{found.operatorName ?? config.operatorName}</strong>,{" "}
            {found.chargerName}, connector {found.connectorNumber}.
          </p>
          {pricing?.private ? (
            <p>
              This is a private charger: it can&apos;t be paid for here. Staff
              and RFID card holders start it with their card.
            </p>
          ) : (
            <>
              {pricing?.tariff?.driverText && (
                <p>
                  <strong>Price:</strong> {pricing.tariff.driverText}
                </p>
              )}
              <p className="muted">
                Paying by card here comes with a later part of this kit. Until
                then, ask the site operator how to start charging.
              </p>
            </>
          )}
        </>
      ) : found ? (
        <p>
          This charger is not in service. Please use another one, or contact the
          site operator.
        </p>
      ) : (
        <p>
          Sticker code <code>{code.slice(0, 16)}</code> is not known here.
          Please contact the site operator.
        </p>
      )}
    </section>
  );
}
