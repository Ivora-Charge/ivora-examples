import { reportPdf } from "@/lib/pdf";
import { isDemo } from "@/lib/server/config";
import {
  guarded,
  pdfResponse,
  requestOrigin,
  type IdContext,
} from "@/lib/server/route";
import { chargerWithSite } from "@/lib/server/service";
import { resolveQrBase } from "@/lib/urls";

/** One-page commissioning report: charger details, test result and date. */
export const GET = guarded({ write: false }, async (req, ctx: IdContext) => {
  const { charger, site } = chargerWithSite((await ctx.params).id);
  const qr = resolveQrBase({
    demo: charger.demo || isDemo(),
    requestOrigin: requestOrigin(req),
  });
  const pdf = await reportPdf({
    charger,
    site,
    stickerBase: qr.ok ? qr.base : null,
  });
  return pdfResponse(pdf, `commissioning-${charger.name}.pdf`);
});
