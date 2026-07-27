import type { OverridesMap } from "../lib/store";

export type RegenPhase =
  | { phase: "idle" }
  | { phase: "prompt"; section: string; instruction: string }
  | { phase: "running"; section: string }
  | { phase: "failed"; section: string; report: string; instruction: string };

export interface RegenControlsProps {
  regen: RegenPhase;
  sectionSelected: string | undefined;
  onOpen: (section: string) => void;
  onEdit: (instruction: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onTryAgain: () => void;
}

/** PRD 4: instruction box pre-filled with the planner brief, cost estimate
 * before confirming, plain-language failure report with try-again. */
export function RegenControls({
  regen,
  sectionSelected,
  onOpen,
  onEdit,
  onConfirm,
  onCancel,
  onTryAgain,
}: RegenControlsProps) {
  if (regen.phase === "idle" && sectionSelected !== undefined) {
    return (
      <button
        type="button"
        data-testid="regen-button"
        className="regen-open"
        onClick={() => onOpen(sectionSelected)}
      >
        Regenerate section
      </button>
    );
  }
  if (regen.phase === "prompt") {
    return (
      <div className="regen-box">
        <h3 className="inspector-subheading">Regenerate {regen.section}</h3>
        <textarea
          data-testid="regen-instruction"
          className="regen-instruction"
          rows={4}
          value={regen.instruction}
          onChange={(event) => onEdit(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div data-testid="regen-cost" className="regen-cost">
          Estimated cost: ~30k tokens (≈ one section)
        </div>
        <div className="regen-actions">
          <button type="button" data-testid="regen-confirm" onClick={onConfirm}>
            Regenerate
          </button>
          <button type="button" data-testid="regen-cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (regen.phase === "failed") {
    return (
      <div className="regen-box regen-failed">
        <h3 className="inspector-subheading">Regeneration failed</h3>
        <p data-testid="regen-failure" className="regen-failure">
          The regenerated section did not pass validation after two retries:
          <br />
          {regen.report}
        </p>
        <button type="button" data-testid="regen-try-again" onClick={onTryAgain}>
          Try a different instruction
        </button>
      </div>
    );
  }
  return null;
}

export interface OrphanDialogProps {
  orphans: string[];
  overrides: OverridesMap;
  onDiscard: (nodeId: string) => void;
  onCopy: (nodeId: string) => void;
}

/** PRD 4.3: non-blocking list of edits whose targets no longer exist —
 * discard, or copy the value to the clipboard. No automatic reattachment. */
export function OrphanDialog({ orphans, overrides, onDiscard, onCopy }: OrphanDialogProps) {
  if (orphans.length === 0) return null;
  return (
    <div data-testid="orphan-dialog" className="orphan-dialog">
      <h3>Orphaned edits</h3>
      <p>These edits no longer have a target after regeneration:</p>
      {orphans.map((nodeId) => (
        <div key={nodeId} data-testid="orphan-item" className="orphan-item">
          <code>{nodeId}</code>
          <span className="orphan-channels">
            {Object.keys(overrides[nodeId] ?? {}).join(", ") || "edit"}
          </span>
          <button type="button" data-testid="orphan-copy" onClick={() => onCopy(nodeId)}>
            Copy value
          </button>
          <button type="button" data-testid="orphan-discard" onClick={() => onDiscard(nodeId)}>
            Discard
          </button>
        </div>
      ))}
    </div>
  );
}
