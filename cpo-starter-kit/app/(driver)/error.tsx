"use client";

import { EmptyState } from "@/app/ui/empty-state";

/**
 * A driver page that failed to load. Says what happened and offers a retry. It covers
 * the session page and a checkout page with a paid session running, so it must never
 * claim nothing was charged: it says only that the error itself did not start, stop or
 * charge anything, and that a payment already made is not affected. Shows the
 * reference, never the message or a stack.
 */
export default function DriverError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="card" aria-labelledby="driver-error-heading">
      <h1 id="driver-error-heading" className="visually-hidden">
        This page could not load
      </h1>
      <EmptyState
        tone="error"
        title="We could not load this page"
        action={
          <button type="button" className="button" onClick={reset}>
            Try again
          </button>
        }
      >
        This error didn&apos;t start, stop or charge anything. A payment you
        already made is not affected. Try again, or contact the site operator
        {error.digest ? (
          <>
            {" "}
            and quote <code>{error.digest}</code>
          </>
        ) : null}
        .
      </EmptyState>
    </section>
  );
}
