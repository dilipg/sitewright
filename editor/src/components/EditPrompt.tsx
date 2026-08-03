/**
 * Prompt-driven editing (PRD 4-adjacent; spec 2026-08-03).
 *
 * One box. The agent resolves which nodes are meant, and the result lands
 * immediately with a summary — overrides are free and reversible, so a confirm
 * step on every edit would cost more than a wrong target does.
 */
export type EditPromptState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; notes: string; applied: string[] }
  | { phase: "clarify"; question: string }
  | { phase: "rejected"; errors: string[] }
  | { phase: "structural"; kind: string; reason: string };

export interface EditPromptProps {
  state: EditPromptState;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onUndo: () => void;
}

export default function EditPrompt({ state, value, onChange, onSubmit, onUndo }: EditPromptProps) {
  return (
    <section className="control-section">
      <h3 className="inspector-subheading">Describe a change</h3>
      <textarea
        data-testid="edit-prompt-input"
        className="regen-instruction"
        rows={2}
        placeholder="make the hero headline shorter"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="regen-actions">
        <button
          type="button"
          data-testid="edit-prompt-submit"
          disabled={state.phase === "running" || value.trim() === ""}
          onClick={onSubmit}
        >
          {state.phase === "running" ? "Working…" : "Apply"}
        </button>
      </div>

      {state.phase === "done" && (
        <div data-testid="edit-prompt-summary" className="inspector-note">
          <p>{state.notes}</p>
          <ul>
            {state.applied.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <button type="button" data-testid="edit-prompt-undo" onClick={onUndo}>
            Undo
          </button>
        </div>
      )}
      {state.phase === "clarify" && (
        <p data-testid="edit-prompt-clarify" className="inspector-note">{state.question}</p>
      )}
      {state.phase === "rejected" && (
        <ul data-testid="edit-prompt-errors" className="inspector-note">
          {state.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {state.phase === "structural" && (
        <p data-testid="edit-prompt-structural" className="inspector-note">
          {state.reason} Use the regenerate or add-section controls to do this — it generates new content.
        </p>
      )}
    </section>
  );
}
