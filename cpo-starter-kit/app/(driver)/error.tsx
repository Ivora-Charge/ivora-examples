"use client";

import { EmptyState } from "@/app/ui/empty-state";

/**
 * A driver page that failed to load. Says what happened, that nothing was charged by
 * this failure (a payment starts only when the driver taps the button), and offers a
 * retry. Shows the reference, never the message or a stack.
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
        Nothing was charged. Try again, or contact the site operator
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
