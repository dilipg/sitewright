import type { NodeProps } from "./types";

/** Labeled placeholder for a section whose bounded retries were exhausted
 * (pipeline 5.4): the page still assembles and the rest stays live; the
 * failure is visible and addressable rather than silently missing. */
export default function FailedSectionPlaceholder({ nodeId }: NodeProps) {
  return (
    <section
      data-node-id={nodeId}
      className="border border-dashed border-(--color-semantic-danger) bg-(--color-semantic-surface) px-(--space-6) py-(--space-12) text-center"
    >
      <p className="text-(length:--typography-scale-sm) text-(--color-semantic-danger)">
        Section failed to generate — see the run log for details.
      </p>
    </section>
  );
}
