import "server-only";
import { NextResponse } from "next/server";
import { ERRORS_URL } from "./config";
import { HttpError, IvoraError } from "./errors";

export type PublicError = {
  error: string;
  message: string;
  request_id?: string;
  docs?: string;
};

/**
 * Turn any error into a response body the operator can act on. Ivora errors
 * keep their code and link to the portal's errors page; unexpected errors are
 * logged by name only, never with secrets or stack traces in the response.
 */
export function publicError(e: unknown): { status: number; body: PublicError } {
  if (e instanceof IvoraError) {
    console.error("[installer-kit] Ivora error", e.code, e.requestId ?? "");
    return {
      // An Ivora 401/403 is a configuration problem, not the operator's login.
      status: e.status === 401 || e.status === 403 ? 502 : e.status,
      body: {
        error: e.code,
        message: e.message,
        ...(e.requestId ? { request_id: e.requestId } : {}),
        docs: ERRORS_URL,
      },
    };
  }
  if (e instanceof HttpError)
    return { status: e.status, body: { error: e.code, message: e.message } };
  if (e instanceof Error && e.name === "ZodError")
    return {
      status: 400,
      body: { error: "invalid_input", message: "Check the form fields." },
    };
  console.error(
    "[installer-kit] unexpected error",
    e instanceof Error ? e.name : "UnknownError",
  );
  return {
    status: 500,
    body: {
      error: "internal_error",
      message: "The server could not complete that action; see its logs.",
    },
  };
}

export function fail(e: unknown) {
  const { status, body } = publicError(e);
  return NextResponse.json(body, { status });
}
