"use client";

import { ErrorBox } from "@/components/error-box";

/** Last-resort boundary: a code, what happened and what to do next, never a stack trace. */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>This page didn&apos;t load</h1>
      <ErrorBox
        info={{
          error: "page_error",
          message:
            "Something went wrong on our side. Try again; if it keeps happening, ask at the counter.",
          requestId: error.digest ?? null,
        }}
      />
      <button className="block" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
