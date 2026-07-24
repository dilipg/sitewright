import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface HeadingProps extends NodeProps {
  /** Semantic heading level (h1-h3), independent of visual size. */
  level?: 1 | 2 | 3;
  variant?: "display" | "section" | "subsection";
  className?: string;
  children: ReactNode;
}

const base = cx(
  "font-(family-name:--typography-fontFamily-heading) font-(--typography-weight-bold)",
  "leading-(--typography-leading-tight) text-(--color-semantic-text)",
);

const variants: Record<NonNullable<HeadingProps["variant"]>, string> = {
  display: "text-(length:--typography-scale-5xl)",
  section: "text-(length:--typography-scale-3xl)",
  subsection: "text-(length:--typography-scale-2xl)",
};

export default function Heading({ nodeId, level = 1, variant = "section", className, children }: HeadingProps) {
  const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  return (
    <Tag data-node-id={nodeId} className={cx(base, variants[variant], className)}>
      {children}
    </Tag>
  );
}
