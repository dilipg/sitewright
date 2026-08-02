import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface ImageProps extends NodeProps {
  src: string;
  alt: string;
  className?: string;
}

export default function Image({ nodeId, src, alt, className }: ImageProps) {
  return (
    <img
      data-node-id={nodeId}
      src={src}
      alt={alt}
      className={cx("w-full rounded-(--radius-md) object-cover", className)}
    />
  );
}
