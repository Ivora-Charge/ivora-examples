import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ERRORS_URL } from "../settings";
import { IvoraError, isRetryLater } from "./ivora";
import { SaleError } from "../store";
import { UserError } from "./sessions";

export type ApiError = {
  error: string;
  message: string;
  requestId: string | null;
  docs: string | null;
  retry: boolean;
};

/** Error details safe to show: the API's code and a link to the portal; never secrets or stack traces. */
export function errorInfo(error: unknown): { body: ApiError; status: number } {
  const none = { requestId: null, docs: null, retry: false };
  if (error instanceof UserError || error instanceof SaleError)
    return {
      body: { ...none, error: error.code, message: error.message },
      status: error.status,
    };
  if (error instanceof IvoraError) {
    console.warn("[forecourt] Ivora error", {
      code: error.code,
      status: error.status,
      requestId: error.requestId,
    });
    const retry = isRetryLater(error);
    return {
      body: {
        error: error.code,
        message: retry
          ? "Still working on it. This retries automatically."
          : error.message,
        requestId: error.requestId,
        docs: ERRORS_URL,
        retry,
      },
      status: retry ? 503 : error.status >= 500 ? 502 : error.status,
    };
  }
  if (error instanceof ZodError)
    return {
      body: {
        ...none,
        error: "invalid_request",
        message: "The request or a response had an unexpected shape.",
      },
      status: 400,
    };
  const stripe = error as {
    type?: unknown;
    code?: string;
    statusCode?: number;
    requestId?: string;
  };
  if (typeof stripe?.type === "string" && stripe.type.startsWith("Stripe")) {
    console.warn("[forecourt] Stripe error", {
      type: stripe.type,
      code: stripe.code ?? null,
      requestId: stripe.requestId ?? null,
    });
    return {
      body: {
        error: stripe.code ?? "payment_error",
        message:
          stripe.type === "StripeCardError"
            ? "The card was declined. Try another card."
            : "The payment provider could not complete the request.",
        requestId: stripe.requestId ?? null,
        docs: null,
        retry:
          stripe.type === "StripeConnectionError" ||
          stripe.type === "StripeRateLimitError",
      },
      status: stripe.statusCode && stripe.statusCode < 500 ? 400 : 502,
    };
  }
  console.error(
    "[forecourt] unexpected error",
    error instanceof Error ? error.name : "unknown",
  );
  return {
    body: {
      ...none,
      error: "server_error",
      message: "The server could not complete the request. Check the logs.",
    },
    status: 500,
  };
}

export function errorResponse(error: unknown) {
  const { body, status } = errorInfo(error);
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Reject cross-site form posts and fetches. */
export function sameOrigin(request: Request) {
  // Browsers send Sec-Fetch-Site on every request; trust it when present.
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true; // not a browser: webhooks and scripts use their own checks
  if (origin === "null") return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
