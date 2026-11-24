"use client";

/** Opens the browser's print dialog: the print view hides the app's chrome. */
export function PrintStatement() {
  return (
    <button
      type="button"
      className="button secondary no-print"
      onClick={() => window.print()}
    >
      Print
    </button>
  );
}
