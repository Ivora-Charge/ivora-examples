import Link from "next/link";
import { ErrorBox } from "@/components/error-box";
import { PrintButton } from "@/components/print-button";
import { StoreReceipt } from "@/components/store-receipt";
import { DEMO_SITE_NAME } from "@/lib/demo";
import { sale } from "@/lib/server/cashier";
import { errorInfo } from "@/lib/server/http";
import { requireCashier } from "@/lib/server/operator-page";

export const dynamic = "force-dynamic";

/** Printable in-store receipt, laid out for an 80 mm thermal printer. */
export default async function StoreReceiptPage({
  params,
}: {
  params: Promise<{ sale: string }>;
}) {
  const s = await requireCashier();
  const { sale: id } = await params;
  try {
    const view = await sale(id, s);
    if (view.phase !== "done")
      return (
        <main>
          <h1>Receipt not ready</h1>
          <p>
            The sale is still {view.phase}. Print it when charging has ended.
          </p>
          <Link href="/cashier">Back to the console</Link>
        </main>
      );
    return (
      <main>
        <p className="no-print">
          <Link href="/cashier">Back to the console</Link>
        </p>
        <h1 className="no-print">Store receipt</h1>
        <StoreReceipt
          view={view}
          siteName={
            s.demo ? DEMO_SITE_NAME : process.env.SITE_NAME || "EV charging"
          }
          timeZone={s.siteTimeZone}
        />
        <PrintButton />
      </main>
    );
  } catch (error) {
    return (
      <main>
        <h1>Receipt unavailable</h1>
        <ErrorBox info={errorInfo(error).body} />
      </main>
    );
  }
}
