import { DatabaseRequestError } from "./supabase-rest";

/**
 * Errors whose message is built from known-safe parts only: the table or endpoint and
 * the HTTP status, never a key, token, email or row value. Their message may be logged.
 * Any other error is logged by name alone, since its message could carry such values.
 */
export class SafeLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeLogError";
  }
}

/** A refused request to Supabase Auth: the endpoint and the HTTP status. */
export class AuthRequestError extends SafeLogError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

/** What to log for a caught error: the name, plus the message when it is known-safe. */
export function logText(e: unknown): string {
  if (e instanceof DatabaseRequestError || e instanceof SafeLogError)
    return `${e.name}: ${e.message}`;
  return e instanceof Error ? e.name : "unknown error";
}
