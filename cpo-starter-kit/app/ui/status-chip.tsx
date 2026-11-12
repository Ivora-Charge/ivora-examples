import type { ReactNode } from "react";
import type { ChipSpec, ChipTone } from "@/lib/status-chips";

/**
 * The one status chip: words, with a shape and colour from the tone (see
 * lib/status-chips.ts). Styled by `.pill` in globals.css.
 */
export function StatusChip({
  tone,
  children,
}: {
  tone: ChipTone;
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Chip({ spec }: { spec: ChipSpec }) {
  return <StatusChip tone={spec.tone}>{spec.label}</StatusChip>;
}
