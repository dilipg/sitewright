import { cx } from "../lib/cx";
import type { NodeProps } from "../lib/types";

export interface InputProps extends NodeProps {
  type?: "text" | "email";
  placeholder?: string;
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

export default function Input({ nodeId, type = "text", placeholder, value, onChange, className }: InputProps) {
  return (
    <input
      data-node-id={nodeId}
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cx(base, className)}
    />
  );
}
