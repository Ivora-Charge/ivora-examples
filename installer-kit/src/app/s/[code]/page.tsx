import { connection } from "next/server";
import { isStickerCode } from "@/lib/codes";
import { resolveStickerCode } from "@/lib/server/service";

/**
 * Where a sticker's QR code lands, on your own domain. Point it at your
 * charging or payment flow (see the forecourt-checkout template); stickers
 * keep working because only this page decides where a code goes.
 */
export default async function Sticker({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await connection();
  const { code } = await params;
  const found = isStickerCode(code) ? resolveStickerCode(code) : null;
  return (
    <main id="main">
      {found?.charger.demo && (
        <p className="banner">Demo sticker: simulated charger.</p>
      )}
      <h1>Charge here</h1>
      {found ? (
        <>
          <p>
            <strong>{found.site.name}</strong>, {found.charger.name}, connector{" "}
            {found.connectorNumber}
          </p>
          <p>
            This page is a placeholder. Connect it to your charging or payment
            flow, for example the forecourt-checkout template.
          </p>
        </>
      ) : (
        <p>
          Sticker code <code>{code}</code> is not known here. Ask the site
          operator for help.
        </p>
      )}
    </main>
  );
}
