"use client";

import { ErrorState } from "../states";

/** A staff page failed: the error state inside the sidebar shell. */
export default function ErrorPage(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState {...props} />;
}
