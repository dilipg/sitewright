/**
 * Add-a-section (PRD 4.1): the "+" between sections opens the archetype
 * catalog with previews plus an instruction box.
 *
 * "This, not freeform drawing, is how users add content in this product" — so
 * the archetype choice comes first and the instruction second, and there is no
 * blank-canvas option at all.
 *
 * The catalog is fetched from the orchestrator's own ARCHETYPE_CATALOG rather
 * than listed here: it decides which archetypes actually have prompt
 * templates, and a copy in the editor would offer the user a section the
 * generator cannot build the moment the two drift.
 */

import { formatElapsedSeconds } from "../lib/jobs";

export interface Archetype {
  name: string;
  description: string;
}

/**
 * `/__add-section` is one of the job-model's five converted endpoints
 * (slice 5): against the hosted server the request is a job, opaque until
 * it finishes, so `running` carries `elapsedMs` — real information, not a
 * fabricated percentage.
 */
export type AddSectionState =
  | { phase: "picking"; route: string; afterSection: string | undefined; archetype?: string; instruction: string }
  | { phase: "running"; route: string; elapsedMs: number }
  | { phase: "failed"; route: string; report: string };

export interface AddSectionPanelProps {
  state: AddSectionState;
  archetypes: Archetype[];
  onPick: (archetype: string) => void;
  onEdit: (instruction: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A schematic preview per archetype: the block shapes it lays down.
 *
 * PRD 4.1 asks for previews, and the honest options are a real screenshot per
 * archetype (which does not exist — every instance is generated fresh, and a
 * stock image of someone else's output would misrepresent what the user gets)
 * or a schematic of the structure. The schematic is what actually distinguishes
 * the choices: the user is picking a SHAPE, and the generated content is what
 * their instruction decides. Falls back to a generic block for any archetype
 * added to the catalog without a shape here — the picker must never hide a
 * buildable archetype just because this map is behind.
 */
const PREVIEW_SHAPES: Record<string, string[]> = {
  hero: ["bar-wide", "bar-mid", "row-buttons"],
  "feature-grid": ["bar-mid", "grid-3"],
  "feature-spotlight": ["bar-mid", "split", "split"],
  "cta-band": ["bar-mid", "row-buttons"],
  "pricing-tiers": ["bar-mid", "grid-3"],
  "faq-accordion": ["bar-mid", "stack-3"],
  "social-proof": ["bar-mid", "grid-3"],
  "stats-band": ["grid-3"],
  "logo-wall": ["bar-mid", "grid-3"],
  "contact-form": ["bar-mid", "stack-3", "row-buttons"],
  "product-grid": ["bar-mid", "grid-3"],
  "collection-header": ["bar-wide", "bar-mid"],
  "product-detail": ["split"],
  "cart-drawer": ["bar-mid", "stack-3", "row-buttons"],
  "comparison-table": ["bar-mid", "grid-3", "grid-3"],
  "changelog-list": ["bar-mid", "stack-3"],
  "category-nav": ["row-buttons"],
  "team-grid": ["bar-mid", "grid-3"],
  "integration-grid": ["bar-mid", "grid-3"],
};

function Preview({ archetype }: { archetype: string }) {
  const shapes = PREVIEW_SHAPES[archetype] ?? ["bar-mid", "stack-3"];
  return (
    <span className="archetype-preview" aria-hidden="true">
      {shapes.map((shape, index) => (
        <span key={`${shape}-${index}`} className={`preview-${shape}`}>
          {shape === "grid-3" || shape === "row-buttons" ? (
            <>
              <i />
              <i />
              <i />
            </>
          ) : shape === "stack-3" ? (
            <>
              <i />
              <i />
              <i />
            </>
          ) : shape === "split" ? (
            <>
              <i />
              <i />
            </>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export function AddSectionPanel({
  state,
  archetypes,
  onPick,
  onEdit,
  onConfirm,
  onCancel,
}: AddSectionPanelProps) {
  if (state.phase === "running") {
    return (
      <div className="add-section-panel" data-testid="add-section-running">
        <h3 className="inspector-subheading">
          Generating a new section… {formatElapsedSeconds(state.elapsedMs)}
        </h3>
        <p className="inspector-note">
          The rest of the page stays live and editable while this runs (PRD 4.1).
        </p>
      </div>
    );
  }
  if (state.phase === "failed") {
    return (
      <div className="add-section-panel" data-testid="add-section-failed">
        <h3 className="inspector-subheading">Could not add the section</h3>
        <pre className="regen-failure" data-testid="add-section-report">
          {state.report}
        </pre>
        <button type="button" data-testid="add-section-dismiss" onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="add-section-panel" data-testid="add-section-panel">
      <h3 className="inspector-subheading">
        {state.afterSection === undefined
          ? `Add a section at the top of ${state.route}`
          : `Add a section after ${state.afterSection.split(".").slice(1).join(".")}`}
      </h3>
      <div className="archetype-catalog" data-testid="archetype-catalog">
        {archetypes.map((archetype) => (
          <button
            type="button"
            key={archetype.name}
            data-testid={`archetype-${archetype.name}`}
            className={`archetype-card${state.archetype === archetype.name ? " selected" : ""}`}
            aria-pressed={state.archetype === archetype.name}
            onClick={() => onPick(archetype.name)}
          >
            <Preview archetype={archetype.name} />
            <span className="archetype-name">{archetype.name}</span>
            <span className="archetype-description">{archetype.description}</span>
          </button>
        ))}
      </div>
      <textarea
        data-testid="add-section-instruction"
        className="regen-instruction"
        rows={3}
        placeholder="What should this section say?"
        value={state.instruction}
        onChange={(event) => onEdit(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div data-testid="add-section-cost" className="regen-cost">
        Estimated cost: ~30k tokens (≈ one section)
      </div>
      <div className="regen-actions">
        <button
          type="button"
          data-testid="add-section-confirm"
          // An archetype is required: the generator selects a prompt template
          // by archetype, so there is nothing to run without one.
          disabled={state.archetype === undefined || state.instruction.trim() === ""}
          onClick={onConfirm}
        >
          Generate section
        </button>
        <button type="button" data-testid="add-section-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
