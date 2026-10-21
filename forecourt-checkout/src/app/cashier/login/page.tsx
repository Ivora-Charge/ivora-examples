import { settings } from "@/lib/server/services";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  wrong_password: "Wrong password.",
  too_many_attempts: "Too many attempts. Wait 15 minutes and try again.",
  not_configured: "Set CASHIER_PASSWORD to turn on pay in store.",
  forbidden: "Sign in from this site's own page.",
};

export default async function CashierLogin({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const s = settings();
  return (
    <main>
      <h1>Cashier sign in</h1>
      {!s.payInStore ? (
        <p className="notice">{MESSAGES.not_configured}</p>
      ) : null}
      <form className="card" action="/api/cashier/login" method="post">
        <label>
          Cashier password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        {error ? (
          <p className="notice bad">{MESSAGES[error] ?? "Sign in failed."}</p>
        ) : null}
        <button type="submit">Sign in</button>
        {s.demo ? <p className="muted">Demo password: demo</p> : null}
      </form>
      <p className="muted">
        The cashier can authorise, stop and take payment. Prices and settings
        are on the operator pages.
      </p>
    </main>
  );
}
