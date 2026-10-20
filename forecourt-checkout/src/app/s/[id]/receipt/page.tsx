import { ErrorBox } from "@/components/error-box";
import { PrintButton } from "@/components/print-button";
import { ReceiptTable } from "@/components/receipt-table";
import { sessionView } from "@/lib/server/driver";
import { errorInfo } from "@/lib/server/http";
import { settings } from "@/lib/server/services";
import { formatLocalDateTime } from "@/lib/time";
import { whToKwhText } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const s = settings();
  try {
    const view = await sessionView(id, s);
    if (!view.receipt)
      return (
        <main>
          <h1>Receipt not ready</h1>
          <p>
            The session is still {view.phase}. Check back when charging has
            ended.
          </p>
        </main>
      );
    const r = view.receipt;
    const tz = s.siteTimeZone;
    return (
      <main>
        <h1>Charging receipt</h1>
        {view.demo ? (
          <p className="pill warn">Demo receipt: nothing was charged</p>
        ) : null}
        <div className="card">
          <table>
            <tbody>
              <tr>
                <td>Charger</td>
                <td className="num">
                  {view.charger.name} · connector {view.charger.connector}
                </td>
              </tr>
              <tr>
                <td>Started</td>
                <td className="num">{formatLocalDateTime(r.startedAt, tz)}</td>
              </tr>
              <tr>
                <td>Ended</td>
                <td className="num">{formatLocalDateTime(r.endedAt, tz)}</td>
              </tr>
              <tr>
                <td>Energy</td>
                <td className="num">{whToKwhText(r.energyWh)} kWh</td>
              </tr>
              <tr>
                <td>Reference</td>
                <td className="num" style={{ wordBreak: "break-all" }}>
                  {view.id.slice(-16)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <ReceiptTable receipt={r} />
        </div>
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
