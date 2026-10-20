import "server-only";
import { UserError } from "./drivers";
import { describeError, IvoraError } from "./ivora";

export const json = (data: unknown, status = 200) =>
  Response.json(data, { status });

/** Errors the operator can fix are 4xx; API errors keep their code and the errors-page link. */
export function fail(e: unknown) {
  if (e instanceof UserError) return json({ error: e.message }, e.status);
  if (e instanceof IvoraError)
    return json(
      { error: describeError(e), code: e.code },
      e.status === 429 ? 429 : 502,
    );
  console.error("fleet-depot:", e instanceof Error ? e.message : e);
  return json({ error: "Internal error; see the server log." }, 500);
}

export async function body<T>(req: Request): Promise<Partial<T>> {
  try {
    const b = (await req.json()) as unknown;
    return b && typeof b === "object" ? (b as Partial<T>) : {};
  } catch {
    throw new UserError("request body must be JSON");
  }
}
