// Rendered on the server (404) and inside the client error boundaries (error.tsx).

/** A page that is not here: says so and offers the way back. */
export function NotFoundState({ home = "/" }: { home?: string }) {
  return (
    <section className="card state" aria-labelledby="nf-heading">
      <p className="state-code">404</p>
      <h1 id="nf-heading">Page not found</h1>
      <p>
        That page does not exist, or it is not turned on for this deployment.
      </p>
      <div className="actions">
        <a className="button" href={home}>
          Back to the start
        </a>
      </div>
    </section>
  );
}

/**
 * The page failed to load. Shows the error reference (the digest Next.js makes, never
 * the message or a stack) and what to do next.
 */
export function ErrorState({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="card state" aria-labelledby="error-heading">
      <p className="state-code">Error</p>
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
          Back to the start
        </a>
      </div>
    </section>
  );
}
