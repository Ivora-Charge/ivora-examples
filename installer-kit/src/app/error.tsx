"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main">
      <h1>Something broke</h1>
      <p role="alert" className="error">
        <strong>page_error</strong>: this page could not load. Tap Try again. If
        it keeps failing, check your connection and reload.
      </p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
