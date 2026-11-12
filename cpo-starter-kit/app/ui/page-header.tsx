import type { ReactNode } from "react";

/**
 * A page's title row: the h1, an optional line under it, and at most one primary
 * action on the right (it wraps below the title on a phone). Put other buttons in
 * the page, not here.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The page's single primary action, e.g. a link styled `button`. */
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </div>
  );
}
