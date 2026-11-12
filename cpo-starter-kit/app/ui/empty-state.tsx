import type { ReactNode } from "react";
import { Icon } from "@/brand/icons";

/**
 * Nothing here yet: says what the list is for and gives one next step (a link or button
 * passed as `action`). `tone="error"` is for a load that failed: it says what happened,
 * whether anything was lost, and offers a way on.
 */
export function EmptyState({
  title,
  children,
  action,
  tone = "empty",
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  tone?: "empty" | "error";
}) {
  return (
    <div className="empty" role={tone === "error" ? "alert" : undefined}>
      <Icon name={tone === "error" ? "alert" : "inbox"} />
      <h3>{title}</h3>
      <p>{children}</p>
      {action && <div className="actions">{action}</div>}
    </div>
  );
}
