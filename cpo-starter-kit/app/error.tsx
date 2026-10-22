"use client";

/**
 * The page failed to load. Shows the error reference (the digest Next.js makes, never
 * the message or a stack) and what to do next.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="card state" aria-labelledby="error-heading">
      <h1 id="error-heading">This page could not load</h1>
      <p className="error" role="alert">
        Something went wrong on our side
        {error.digest ? (
          <>
            {" "}
            (reference <code>{error.digest}</code>)
          </>
        ) : null}
        .
      </p>
      <p>
        Try again. If it keeps happening, check that your deployment&apos;s
        settings are complete and quote the reference to your administrator.
      </p>
      <div className="actions">
        <button type="button" className="button" onClick={reset}>
          Try again
        </button>
        <a className="button secondary" href="/">
          Back to the overview
        </a>
      </div>
    </section>
  );
}
