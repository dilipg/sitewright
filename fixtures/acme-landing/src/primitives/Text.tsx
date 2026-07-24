import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface TextProps extends NodeProps {
  variant?: "body" | "lead" | "eyebrow";
  className?: string;
  children: ReactNode;
}

const base = "font-(family-name:--typography-fontFamily-body)";

const variants: Record<NonNullable<TextProps["variant"]>, string> = {
  body: cx(
    "text-(length:--typography-scale-base) leading-(--typography-leading-normal)",
    "text-(--color-semantic-text)",
  ),
  lead: cx(
    "text-(length:--typography-scale-lg) leading-(--typography-leading-relaxed)",
    "text-(--color-semantic-textMuted)",
  ),
  eyebrow: cx(
    "text-(length:--typography-scale-sm) leading-(--typography-leading-snug)",
    "font-(--typography-weight-semibold) tracking-[0.08em] uppercase",
    "text-(--color-semantic-accent)",
  ),
};

export default function Text({ nodeId, variant = "body", className, children }: TextProps) {
  return (
    <p data-node-id={nodeId} className={cx(base, variants[variant], className)}>
      {children}
    </p>
  );
}
