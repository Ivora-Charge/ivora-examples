import { settings } from "@/lib/server/services";

export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  wrong_password: "Wrong password.",
  too_many_attempts: "Too many attempts. Wait 15 minutes and try again.",
  not_configured: "Set OPERATOR_PASSWORD to enable the operator pages.",
  forbidden: "Sign in from this site's own page.",
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const demo = settings().demo;
  return (
    <main>
      <h1>Operator sign in</h1>
      <form className="card" action="/api/operator/login" method="post">
        <label>
          Password
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
        {demo ? <p className="muted">Demo password: demo</p> : null}
      </form>
    </main>
  );
}
