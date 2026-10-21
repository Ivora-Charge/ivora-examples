"use client";

import type { ActionState } from "@/lib/action-state";

/** A form's outcome: an error, or a success message with any invite link or preview. */
export function Result({ state }: { state: ActionState }) {
  if (state.error)
    return (
      <p className="error" role="alert">
        {state.error}
      </p>
    );
  if (!state.ok) return null;
  return (
    <div className="success" role="status">
      <p>{state.ok}</p>
      {state.preview && (
        <pre className="preview" aria-label="Email preview">
          {`To: ${state.preview.to}\nSubject: ${state.preview.subject}\n\n${state.preview.text}`}
        </pre>
      )}
      {state.link && !state.preview && (
        <input
          readOnly
          aria-label="Invite link"
          value={state.link}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      {state.preview && state.path && (
        <p>
          <a href={state.path}>Open the invite link</a>
        </p>
      )}
    </div>
  );
}
