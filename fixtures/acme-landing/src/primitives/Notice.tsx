import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface NoticeProps extends NodeProps {
  /** info: loading or neutral status · error: something failed · success: something worked. */
  variant?: "info" | "error" | "success";
  className?: string;
  children: ReactNode;
}

const base = cx(
  "block rounded-(--radius-md) border border-solid px-(--space-4) py-(--space-3)",
  "font-(family-name:--typography-fontFamily-body) text-(length:--typography-scale-sm)",
);

const variants: Record<NonNullable<NoticeProps["variant"]>, string> = {
  info: "border-(--color-semantic-border) bg-(--color-semantic-surface) text-(--color-semantic-textMuted)",
  error: "border-(--color-semantic-danger) bg-(--color-semantic-surface) text-(--color-semantic-danger)",
  success: "border-(--color-semantic-success) bg-(--color-semantic-surface) text-(--color-semantic-success)",
};

/**
 * Runtime status surface: loading, error, success. Exists because a receiving
 * developer wiring a section to a real API has to render those three states
 * somewhere, and had nothing to render them WITH — both 6.4 handover trials
 * hand-composed status markup out of Container + Text, in a page container
 * whose own docblock disclaims styling decisions.
 *
 * Not for section copy — sections take their content through props. This is
 * for the integration layer.
 */
export default function Notice({ nodeId, variant = "info", className, children }: NoticeProps) {
  return (
    <div data-node-id={nodeId} role="status" className={cx(base, variants[variant], className)}>
      {children}
    </div>
  );
}
