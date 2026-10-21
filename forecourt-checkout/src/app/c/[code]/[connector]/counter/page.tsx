import { ErrorBox } from "@/components/error-box";
import { CounterScreen } from "@/components/counter-screen";
import { chargerFor } from "@/lib/server/driver";
import { errorInfo } from "@/lib/server/http";
import { settings } from "@/lib/server/services";

export const dynamic = "force-dynamic";

/** The driver chose "Pay at the counter" on the charger page. */
export default async function Counter({
  params,
}: {
  params: Promise<{ code: string; connector: string }>;
}) {
  const { code, connector } = await params;
  const s = settings();
  try {
    if (!s.payInStore || !/^\d{1,2}$/.test(connector))
      throw new Error("not available");
    const page = await chargerFor(
      decodeURIComponent(code),
      Number(connector),
      s,
    );
    return (
      <main>
        <p className="muted" style={{ marginBottom: 0 }}>
          {page.name} · {page.connector.label}
        </p>
        <h1>Pay at the counter</h1>
        <CounterScreen
          code={page.code}
          connector={page.connector.number}
          label={page.label}
        />
      </main>
    );
  } catch (error) {
    const info =
      error instanceof Error && error.message === "not available"
        ? {
            error: "pay_in_store_off",
            message: "This site doesn't take payment at the counter.",
          }
        : errorInfo(error).body;
    return (
      <main>
        <h1>Charger unavailable</h1>
        <ErrorBox info={info} />
      </main>
    );
  }
}
