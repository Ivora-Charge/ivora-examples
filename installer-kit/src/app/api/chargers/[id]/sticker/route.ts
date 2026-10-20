import { stickerPdf } from "@/lib/pdf";
import { isDemo } from "@/lib/server/config";
import { HttpError } from "@/lib/server/errors";
import {
  guarded,
  pdfResponse,
  requestOrigin,
  type IdContext,
} from "@/lib/server/route";
import { chargerWithSite } from "@/lib/server/service";
import { resolveQrBase, stickerUrl } from "@/lib/urls";

/** Printable QR sticker for one connector, on the deployer's own domain. */
export const GET = guarded({ write: false }, async (req, ctx: IdContext) => {
  const { charger, site } = chargerWithSite((await ctx.params).id);
  const number = Number(req.nextUrl.searchParams.get("connector") ?? "1");
  const connector = charger.connectors.find((k) => k.number === number);
  if (!connector?.code)
    throw new HttpError(
      404,
      "not_found",
      "That connector has not been reported by the charger yet.",
    );
  const qr = resolveQrBase({
    demo: charger.demo || isDemo(),
    requestOrigin: requestOrigin(req),
  });
  if (!qr.ok) throw new HttpError(409, "qr_base_url_invalid", qr.reason);
  const pdf = await stickerPdf({
    url: stickerUrl(qr.base, connector.code),
    code: connector.code,
    siteName: site.name,
    chargerName: charger.name,
    connectorNumber: connector.number,
    demo: qr.demo,
  });
  return pdfResponse(pdf, `sticker-${connector.code}.pdf`);
});
