import "server-only";

export const ERRORS_URL =
  "https://ivoracharge.com/developers/guides/reference/errors";

export class IvoraError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfterSeconds?: number,
    /** The API's structured context (for example details.errors of tariff_invalid). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IvoraError";
  }
}

/** Operator-facing message: the API's code, what to do next, and the errors-page link. */
export function describeError(e: unknown): string {
  if (e instanceof IvoraError) {
    const next =
      e.status === 401 || e.status === 403
        ? " Check the API key and its permissions."
        : e.status === 429
          ? " Rate limited; try again shortly."
          : e.status === 0 || e.status >= 500
            ? " Ivora could not be reached or is busy; try again later."
            : "";
    const req = e.requestId ? ` Request ${e.requestId}.` : "";
    return `Ivora API error ${e.code} (HTTP ${e.status || "-"}): ${e.message}.${next}${req} See ${ERRORS_URL}`;
  }
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * The problems of a `422 tariff_invalid` (details.errors: element, field, message), as
 * lines staff can read. Empty for any other error.
 */
export function tariffProblems(e: unknown): string[] {
  if (!(e instanceof IvoraError) || !Array.isArray(e.details?.errors))
    return [];
  return (e.details.errors as unknown[]).slice(0, 20).flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const { element, field, message } = x as Record<string, unknown>;
    if (typeof message !== "string") return [];
    const where = [
      typeof element === "number" ? `element ${element}` : null,
      typeof field === "string" ? field : null,
    ]
      .filter(Boolean)
      .join(", ");
    return [`${where ? `${where}: ` : ""}${message.slice(0, 300)}`];
  });
}
