import type { ReactNode } from "react";
import { Icon } from "@/brand/icons";

/**
 * An info control: a 44 px button-like summary that opens the explanation in place
 * (no script, works with the keyboard, nothing floats over other content). Put the
 * words a page used to carry in a paragraph here. `label` names what it explains.
 */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="info">
      <summary aria-label={`About ${label}`}>
        <Icon name="info" />
      </summary>
      <div className="info-panel">{children}</div>
    </details>
  );
}
