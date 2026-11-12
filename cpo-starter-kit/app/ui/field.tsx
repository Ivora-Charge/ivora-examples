import type { ReactNode } from "react";
import { Icon } from "@/brand/icons";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * The form pattern: label above, help under the label, the control, then the inline
 * error under the control. The control gets the ids that tie help and error to it, so
 * a screen reader reads them with the label.
 */
export function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const ids = [help && `${id}-help`, error && `${id}-error`].filter(Boolean);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {help && (
        <p id={`${id}-help`} className="help">
          {help}
        </p>
      )}
      {children({
        id,
        "aria-describedby": ids.length ? ids.join(" ") : undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The row under a form: its buttons, then the Saved state once the change is stored. */
export function FormActions({
  saved,
  children,
}: {
  saved?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="form-actions">
      {children}
      <SavedState saved={saved} />
    </div>
  );
}

/** "Saved", with a check, announced politely; the live region stays in the page. */
export function SavedState({ saved }: { saved?: boolean }) {
  return (
    <span className="saved" role="status">
      {saved && (
        <>
          <Icon name="check" />
          Saved
        </>
      )}
    </span>
  );
}
