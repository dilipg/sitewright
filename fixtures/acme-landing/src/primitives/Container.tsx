import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface ContainerProps extends NodeProps {
  className?: string;
  children: ReactNode;
}

/** Centered max-width content wrapper. Width is token-bound to the xl breakpoint. */
export default function Container({ nodeId, className, children }: ContainerProps) {
  return (
    <div
      data-node-id={nodeId}
      className={cx("mx-auto w-full max-w-(--breakpoint-xl) px-(--space-6)", className)}
    >
      {children}
    </div>
  );
}
