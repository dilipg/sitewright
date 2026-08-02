import { useState } from "react";
import type { ManifestNode } from "@website-generator/compiler/src/manifest.ts";
import { PRIMITIVE_VARIANTS } from "../lib/inventory";
import { humanizeSegment } from "../lib/labels";
import type { TokensJson } from "../lib/tokens";
import { isTokenRef, scaleKeys, semanticColorOptions } from "../lib/tokens";

export interface InspectorProps {
  nodeId: string;
  node: ManifestNode;
  tokens: TokensJson;
  tokenPaths: Set<string>;
  styleValue: Record<string, string>;
  onCommit: (property: string, value: string) => void;
  hidden: boolean;
  onToggleVisibility: () => void;
  /** Current src override on an Image node, when one is set (PRD 3.5). */
  imageSrc?: string;
  onCommitImageSrc: (src: string) => void;
  /** Present only on a section root, the one node a reorder can address (PRD 3.3). */
  reorder?: { position: number; total: number; onMove: (direction: -1 | 1) => void };
}

export default function Inspector({
  nodeId,
  node,
  tokens,
  tokenPaths,
  styleValue,
  onCommit,
  hidden,
  onToggleVisibility,
  imageSrc,
  onCommitImageSrc,
  reorder,
}: InspectorProps) {
  const styleEditable = node.editable.includes("style");
  const visibilityEditable = node.editable.includes("visibility");
  const variants = PRIMITIVE_VARIANTS[node.element];

  return (
    <>
      <h2 className="inspector-heading">{humanizeSegment(nodeId.split(".").pop()!)}</h2>
      <code className="inspector-id">{nodeId}</code>
      <dl className="inspector-meta">
        <dt>Element</dt>
        <dd>{node.element}</dd>
      </dl>
      <h3 className="inspector-subheading">Editable channels</h3>
      <div>
        {node.editable.map((channel) => (
          <span key={channel} data-testid="channel-badge" className="badge">
            {channel}
          </span>
        ))}
      </div>

      {node.element === "Image" && (
        <section className="control-section">
          <h3 className="inspector-subheading">Image</h3>
          {/* PRD 3.5: replacing a source is CONTENT, so it rides the text
              channel with key "src" rather than a channel of its own. */}
          <input
            data-testid="image-src-input"
            className="custom-input"
            type="text"
            defaultValue={imageSrc ?? ""}
            placeholder="Image URL"
            key={nodeId + ":" + (imageSrc ?? "")}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitImageSrc(event.currentTarget.value);
            }}
          />
        </section>
      )}

      {reorder !== undefined && (
        <section className="control-section">
          <h3 className="inspector-subheading">Position on page</h3>
          <div className="reorder-row">
            <button
              type="button"
              data-testid="reorder-up"
              disabled={reorder.position === 0}
              onClick={() => reorder.onMove(-1)}
            >
              ↑ Move up
            </button>
            <button
              type="button"
              data-testid="reorder-down"
              disabled={reorder.position === reorder.total - 1}
              onClick={() => reorder.onMove(1)}
            >
              ↓ Move down
            </button>
          </div>
          <p className="inspector-note" data-testid="reorder-position">
            Section {reorder.position + 1} of {reorder.total}
          </p>
        </section>
      )}

      {visibilityEditable && (
        <section className="control-section">
          <h3 className="inspector-subheading">Visibility</h3>
          <button
            type="button"
            data-testid="visibility-toggle"
            className="visibility-toggle"
            aria-pressed={hidden}
            onClick={onToggleVisibility}
          >
            {hidden ? "Hidden — click to show" : "Visible — click to hide"}
          </button>
        </section>
      )}

      {styleEditable && (
        <>
          {variants !== undefined && (
            <section className="control-section">
              <h3 className="inspector-subheading">Variant</h3>
              <div className="variant-row">
                {variants.variants.map((variant) => (
                  <button
                    key={variant}
                    type="button"
                    data-testid={`variant-${variant}`}
                    className={
                      styleValue["variant"] === variant ? "variant-btn active" : "variant-btn"
                    }
                    onClick={() => onCommit("variant", variant)}
                  >
                    {variant}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="control-section">
            <h3 className="inspector-subheading">Color</h3>
            <SwatchRow label="Background" property="background" tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
            <SwatchRow label="Text" property="color" tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
          </section>

          <section className="control-section">
            <h3 className="inspector-subheading">Typography</h3>
            <StepperRow label="Size" property="fontSize" groupPath={["typography", "scale"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
            <StepperRow label="Weight" property="fontWeight" groupPath={["typography", "weight"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
            <StepperRow label="Leading" property="lineHeight" groupPath={["typography", "leading"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
          </section>

          <section className="control-section">
            <h3 className="inspector-subheading">Spacing</h3>
            <StepperRow label="Padding" property="padding" groupPath={["space"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
            <StepperRow label="Margin Top" property="marginTop" groupPath={["space"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
            <StepperRow label="Margin Bottom" property="marginBottom" groupPath={["space"]} tokens={tokens} tokenPaths={tokenPaths} styleValue={styleValue} onCommit={onCommit} />
          </section>
        </>
      )}
    </>
  );
}

interface ControlProps {
  label: string;
  property: string;
  tokens: TokensJson;
  tokenPaths: Set<string>;
  styleValue: Record<string, string>;
  onCommit: (property: string, value: string) => void;
}

function OffScaleBadge({ value, tokenPaths }: { value: string | undefined; tokenPaths: Set<string> }) {
  if (value === undefined || isTokenRef(value, tokenPaths)) return null;
  return (
    <span data-testid="offscale-badge" className="badge badge-warn" title={value}>
      off-scale
    </span>
  );
}

/** The free-value escape: deliberately one click deeper than the token controls (PRD 3.2). */
function CustomEscape({ property, onCommit }: { property: string; onCommit: (property: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        data-testid={`custom-toggle-${property}`}
        className="custom-toggle"
        onClick={() => setOpen(true)}
      >
        Custom…
      </button>
    );
  }
  return (
    <input
      data-testid={`custom-input-${property}`}
      className="custom-input"
      value={draft}
      placeholder="raw value"
      autoFocus
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" && draft.trim() !== "") {
          onCommit(property, draft.trim());
          setOpen(false);
          setDraft("");
        }
        if (event.key === "Escape") setOpen(false);
      }}
    />
  );
}

function SwatchRow({ label, property, tokens, tokenPaths, styleValue, onCommit }: ControlProps) {
  const current = styleValue[property];
  return (
    <div className="control-row">
      <span className="control-label">{label}</span>
      <div className="swatches">
        {semanticColorOptions(tokens).map((option) => (
          <button
            key={option.path}
            type="button"
            data-testid={`swatch-${property}-${option.path}`}
            title={option.label}
            className={current === option.path ? "swatch active" : "swatch"}
            style={{ background: option.css }}
            onClick={() => onCommit(property, option.path)}
          />
        ))}
      </div>
      <OffScaleBadge value={current} tokenPaths={tokenPaths} />
      <CustomEscape property={property} onCommit={onCommit} />
    </div>
  );
}

function StepperRow({
  label,
  property,
  groupPath,
  tokens,
  tokenPaths,
  styleValue,
  onCommit,
}: ControlProps & { groupPath: string[] }) {
  const keys = scaleKeys(tokens, groupPath);
  const prefix = `${groupPath.join(".")}.`;
  const current = styleValue[property];
  const index = current !== undefined && current.startsWith(prefix) ? keys.indexOf(current.slice(prefix.length)) : -1;
  const display = current === undefined ? "–" : current.startsWith(prefix) ? current.slice(prefix.length) : current;

  const step = (delta: number) => {
    const next =
      index === -1
        ? Math.floor(keys.length / 2)
        : Math.min(keys.length - 1, Math.max(0, index + delta));
    onCommit(property, `${prefix}${keys[next]}`);
  };

  return (
    <div className="control-row">
      <span className="control-label">{label}</span>
      <div className="stepper">
        <button type="button" data-testid={`stepper-dec-${property}`} onClick={() => step(-1)}>
          −
        </button>
        <span className="stepper-value">{display}</span>
        <button type="button" data-testid={`stepper-inc-${property}`} onClick={() => step(1)}>
          +
        </button>
      </div>
      <OffScaleBadge value={current} tokenPaths={tokenPaths} />
      <CustomEscape property={property} onCommit={onCommit} />
    </div>
  );
}
