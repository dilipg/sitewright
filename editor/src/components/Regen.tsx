import type { OverridesMap } from "../lib/store";

/** PRD section 4, last paragraph: "Page-level regeneration ('redo this whole
 *  page') is P1 and reuses the same flow at page granularity." Scope is
 *  therefore a parameter of the one regen flow, not a second flow — and for
 *  "page" the `section` field carries the ROUTE SLUG, which is the thing being
 *  regenerated. */
export type RegenScope = "section" | "page";

export type RegenPhase =
  | { phase: "idle" }
  | { phase: "prompt"; section: string; instruction: string; scope: RegenScope }
  | { phase: "running"; section: string; scope: RegenScope }
  | { phase: "failed"; section: string; report: string; instruction: string; scope: RegenScope };

export interface RegenControlsProps {
  regen: RegenPhase;
  sectionSelected: string | undefined;
  /** How many sections a page regen would cover — drives the cost estimate,
   *  which is the whole point of showing it before confirming (PRD 4.1). */
  pageSectionCount: number;
  onOpen: (target: string, scope: RegenScope) => void;
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
  pageSectionCount,
  onOpen,
  onEdit,
  onConfirm,
  onCancel,
  onTryAgain,
}: RegenControlsProps) {
  if (regen.phase === "idle" && sectionSelected !== undefined) {
    return (
      <div className="regen-open-row">
        <button
          type="button"
          data-testid="regen-button"
          className="regen-open"
          onClick={() => onOpen(sectionSelected, "section")}
        >
          Regenerate section
        </button>
        <button
          type="button"
          data-testid="regen-page-button"
          className="regen-open"
          onClick={() => onOpen(sectionSelected.split(".")[0]!, "page")}
        >
          Regenerate whole page
        </button>
      </div>
    );
  }
  if (regen.phase === "prompt") {
    return (
      <div className="regen-box">
        <h3 className="inspector-subheading">
          {regen.scope === "page" ? `Regenerate the whole ${regen.section} page` : `Regenerate ${regen.section}`}
        </h3>
        <textarea
          data-testid="regen-instruction"
          className="regen-instruction"
          rows={4}
          value={regen.instruction}
          onChange={(event) => onEdit(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <div data-testid="regen-cost" className="regen-cost">
          {regen.scope === "page"
            ? `Estimated cost: ~${30 * pageSectionCount}k tokens (≈ ${pageSectionCount} sections, regenerated one at a time)`
            : "Estimated cost: ~30k tokens (≈ one section)"}
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
