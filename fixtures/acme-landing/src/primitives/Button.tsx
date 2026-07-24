import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface ButtonProps extends NodeProps {
  variant?: "primary" | "secondary";
  /** Renders an anchor styled as a button. Must exist in shell/routes.ts or be explicitly external. */
  href?: string;
  className?: string;
  children: ReactNode;
}

const base = cx(
  "inline-block cursor-pointer rounded-(--radius-md) border-none px-(--space-6) py-(--space-3)",
  "font-(family-name:--typography-fontFamily-body) text-(length:--typography-scale-base)",
  "font-(--typography-weight-semibold) leading-(--typography-leading-tight) no-underline",
);

const variants: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-(--color-semantic-accent) text-(--color-semantic-accentContrast)",
  secondary: cx(
    "border border-solid border-(--color-semantic-border)",
    "bg-(--color-semantic-surface) text-(--color-semantic-text)",
  ),
};

export default function Button({ nodeId, variant = "primary", href, className, children }: ButtonProps) {
  const cls = cx(base, variants[variant], className);
  if (href !== undefined) {
    return (
      <a data-node-id={nodeId} href={href} className={cls}>
        {children}
      </a>
    );
  }
  return (
    <button data-node-id={nodeId} type="button" className={cls}>
      {children}
    </button>
  );
}
