import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface TextareaProps extends NodeProps {
  placeholder?: string;
  rows?: number;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

const base = cx(
  "block w-full rounded-(--radius-md) border border-solid border-(--color-semantic-border)",
  "bg-(--color-semantic-surface) px-(--space-4) py-(--space-3)",
  "font-(family-name:--typography-fontFamily-body) text-(length:--typography-scale-base)",
  "text-(--color-semantic-text)",
);

export default function Textarea({ nodeId, placeholder, rows = 4, value, onChange, className }: TextareaProps) {
  return (
    <textarea
      data-node-id={nodeId}
      placeholder={placeholder}
      rows={rows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cx(base, className)}
    />
  );
}
