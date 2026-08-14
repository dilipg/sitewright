/**
 * Export result surface (PRD section 5, build prompt 6.2).
 *
 * Success shows what the developer is actually receiving — the packaged file
 * tree, the generated HANDOVER.md, and the counts that matter (integration
 * TODOs, off-scale edits) — plus the download.
 *
 * Failure is deliberately loud and specific: the failing gate's own report,
 * per failure, plus the build log. "Export failed" with no detail would make
 * the one unforgivable failure mode (preview ≠ handover) undiagnosable, so
 * nothing here collapses into a generic message.
 */

import { useMemo, useState } from "react";

export interface GateFailure {
  gate: number;
  reason: string;
  file?: string;
  line?: number;
  message: string;
}

export interface GateResult {
  gate: number;
  name: string;
  passed: boolean;
  failures: GateFailure[];
}

export interface ExportSuccess {
  ok: true;
  files: string[];
  handover: string;
  integrationCount: number;
  offScaleCount: number;
  appliedOverrides: number;
  tombstoned: string[];
  zipName: string;
  zipBytes: number;
}

export interface ExportFailure {
  ok: false;
  message: string;
  gateReport?: { passed: boolean; gates: GateResult[] };
  buildLog?: string;
}

export type ExportOutcome = ExportSuccess | ExportFailure;

export interface ExportPanelProps {
  outcome: ExportOutcome;
  downloadUrl: string;
  onClose: () => void;
  onRetry: () => void;
  /**
   * The route slugs the canvas actually has (DOGFOOD G3). Used only to tell a
   * page that CAN be regenerated from here apart from one that is missing from
   * the manifest altogether and therefore unreachable — see
   * `describeBlockedRemedy`. Optional so a caller with no route table still gets
   * an honest, if less specific, remedy.
   */
  canvasRoutes?: readonly string[];
}

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

/** Flat sorted paths -> nested tree. Paths always use forward slashes (exporter contract). */
export function buildFileTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map(), isFile: false };
  for (const path of paths) {
    const segments = path.split("/");
    let current = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      let child = current.children.get(segment);
      if (child === undefined) {
        child = { name: segment, children: new Map(), isFile: isLeaf };
        current.children.set(segment, child);
      }
      current = child;
    });
  }
  return root;
}

function FileTree({ node, depth }: { node: TreeNode; depth: number }) {
  // Directories before files, each alphabetical — the order a developer
  // browsing a repo expects, and stable regardless of input order.
  const entries = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className="file-tree-level">
      {entries.map((entry) => (
        <li key={entry.name} className={entry.isFile ? "file-tree-file" : "file-tree-dir"}>
          <span style={{ paddingLeft: `${String(depth * 12)}px` }}>
            {entry.isFile ? "" : "/"}
            {entry.name}
          </span>
          {!entry.isFile && <FileTree node={entry} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * DOGFOOD G3 — a wrecked run must not look like a retryable one
 * ------------------------------------------------------------------ */

/**
 * Gate 4's own reasons for "the generated source and `manifest.json` disagree"
 * (`compiler/src/gates.ts`'s `gateNodeIdsRegistered`).
 *
 * WHY THESE FOUR AND NOTHING ELSE. A dogfood generation lost one section's
 * `commit_section_manifest` step to a SQLite collision between two page
 * workers: `ContactHero.tsx` is on disk, its node ids are not in the manifest,
 * and gate 4 rejects the export — correctly, and **permanently**. Nothing in
 * this editor writes generated source and nothing writes the manifest (both are
 * agent-owned, CLAUDE.md's ownership map), and the exporter is deterministic, so
 * every retry reads the same mismatch and stops at the same gate. The panel
 * offered exactly one button, "Try export again", which could never succeed.
 *
 * Every OTHER failure keeps today's retry, and that is not caution for its own
 * sake — it is the difference between the two cases. An override that names a
 * token which does not exist (`export.spec.ts`'s own failing export) reaches
 * here with no gate report at all, and the user CAN fix it: change the override
 * and export again. A gate 3 or gate 5 failure can likewise be provoked by an
 * override the editor owns. Only the node-registry reasons are provably beyond
 * anything this editor can change.
 */
export const UNREPAIRABLE_GATE_REASONS: ReadonlySet<string> = new Set([
  "missing-manifest",
  "unregistered-node-id",
  "missing-node-id",
  "duplicate-node-id",
]);

export interface BlockedExport {
  readonly kind: "blocked";
  /** Route slugs whose files carry the mismatch, derived from the failing gate's
   *  own `file` paths — the pages a regeneration would have to rewrite. */
  readonly routes: readonly string[];
}

export type ExportFailureShape = BlockedExport | { readonly kind: "retryable" };

/** `src/pages/<slug>/…` -> `<slug>`. Manifest and gate paths always use forward
 *  slashes (exporter contract), so this needs no platform handling. */
function routeOfFile(file: string | undefined): string | undefined {
  return file === undefined ? undefined : /^src\/pages\/([^/]+)\//.exec(file)?.[1];
}

/**
 * The routes named by the unrepairable failures, de-duplicated, in first-seen
 * order. Sorted deliberately NOT alphabetically: the order a report lists its
 * failures in is the order a reader is already scanning.
 *
 * A failure with no `file` (gate 4's `missing-manifest` has none — the whole
 * registry is gone, not one page's entry) contributes no route, which is why the
 * rendered advice has to hold for an empty list.
 */
export function affectedRoutesOf(gates: readonly GateResult[]): string[] {
  const routes: string[] = [];
  for (const gate of gates) {
    for (const failure of gate.failures) {
      if (!UNREPAIRABLE_GATE_REASONS.has(failure.reason)) continue;
      const route = routeOfFile(failure.file);
      if (route !== undefined && !routes.includes(route)) routes.push(route);
    }
  }
  return routes;
}

/**
 * Whether this failure can honestly offer a retry.
 *
 * Keyed on the gate REASON, a machine-readable field, never on the message text
 * — the message is prose written for a human and is the thing most likely to be
 * reworded, and a classifier that reads it would silently start offering the
 * impossible retry again the day somebody improved a sentence.
 */
export function classifyExportFailure(outcome: ExportFailure): ExportFailureShape {
  const gates = outcome.gateReport?.gates ?? [];
  const blocked = gates.some((gate) =>
    gate.failures.some((failure) => UNREPAIRABLE_GATE_REASONS.has(failure.reason)),
  );
  return blocked ? { kind: "blocked", routes: affectedRoutesOf(gates) } : { kind: "retryable" };
}

export const BLOCKED_TITLE = "This site was generated, but it cannot be exported";

/**
 * WHY, in the terms a user can act on: the code is fine, the registry entry for
 * it is missing, and the registry is written during generation.
 *
 * It says "nothing you edited is lost" because that is the first thing a tester
 * fears on meeting this, and it is true: overrides live in `overrides/*.json`,
 * the exporter never writes into the source project, and a refused export
 * changes nothing at all.
 */
export const BLOCKED_EXPLANATION =
  "Some of this site's code is not registered in manifest.json, which is the registry the editor and the exporter both address nodes through. That registration is written during generation, and it was lost there — the code on disk is fine, nothing you edited is lost, and nothing was shipped.";

/** The sentence that replaces the retry button. A retry that cannot succeed is
 *  the same class of lie as advice a user cannot follow. */
export const BLOCKED_VERDICT =
  "Exporting again cannot change this. The export is deterministic, and nothing in this editor writes either the generated code or manifest.json, so every attempt reads the same mismatch and stops at the same gate.";

/**
 * The inspector's real page-regeneration button, quoted rather than paraphrased.
 *
 * This branch of this codebase has already shipped one piece of advice naming a
 * control that did not exist ("Select the placeholder on the canvas", fixed in
 * `07c23e2` — the placeholder carries no node id and cannot be selected). Naming
 * "Regenerate page" when the button says "Regenerate whole page" is a smaller
 * version of the same failure: a tester scans the panel for the words they were
 * given.
 */
export const REGENERATE_PAGE_BUTTON_LABEL = "Regenerate whole page";

/**
 * What CAN change this, told apart by whether the affected page is REACHABLE.
 *
 * This is the distinction the dogfood run turned on. When a section's manifest
 * commit is lost and it was the only section on its route, that route has no
 * manifest entry either — so the canvas's own tab strip showed only `Home` while
 * the generated nav linked to `Contact`. "Select a section on the contact page"
 * is then advice that cannot be followed, which is the exact class of lie this
 * whole fix is about. So the caller passes the routes the canvas actually has,
 * and each affected page is sorted into the remedy that applies to it.
 *
 * `canvasRoutes === undefined` means the caller does not know — then both
 * remedies are stated without claiming which applies, which is still honest and
 * keeps this component usable from a caller that has no route table.
 */
export function describeBlockedRemedy(
  routes: readonly string[],
  canvasRoutes?: readonly string[],
): string {
  const regenerate = (list: string, plural: boolean): string =>
    `Select a section on the affected ${plural ? "pages" : "page"} (${list}) and press “${REGENERATE_PAGE_BUTTON_LABEL}”: that rewrites the page's sections and registers them again.`;
  const regenerateFromBrief = (subject: string): string =>
    `${subject} generate the site again from your brief.`;

  if (routes.length === 0) {
    // Gate 4's `missing-manifest` names no file, so there is no page to blame.
    return regenerateFromBrief("No single page can be blamed — the whole node registry is unreadable, so");
  }
  if (canvasRoutes === undefined) {
    return `${regenerate(routes.join(", "), routes.length > 1)} ${regenerateFromBrief(
      "If a page the site's own navigation links to is missing from this canvas, nothing here can reach it, and the only way to recover it is to",
    )}`;
  }
  const reachable = routes.filter((route) => canvasRoutes.includes(route));
  const missing = routes.filter((route) => !canvasRoutes.includes(route));
  const parts: string[] = [];
  if (reachable.length > 0) parts.push(regenerate(reachable.join(", "), reachable.length > 1));
  if (missing.length > 0) {
    const list = missing.join(", ");
    const verb = missing.length > 1 ? "are" : "is";
    const it = missing.length > 1 ? "them" : "it";
    parts.push(
      `${list} ${verb} missing from this canvas entirely, so nothing here can select or regenerate ${it} — ${regenerateFromBrief("to recover it,")}`,
    );
  }
  return parts.join(" ");
}

/**
 * DOGFOOD G8: the panel printed all five gate violations TWICE — once as prose
 * inside `message`, once under the "Gate 4" heading.
 *
 * `compiler/src/exporter.ts` builds the message as `Export failed validation
 * gates:` followed by one `- <failure.message>` line per failure, and the
 * structured `gateReport` carries those same messages field by field. So when
 * the report is rendered, the bullets are dropped and the headline kept; when
 * there is no report (an override that cannot compile, a build failure, a
 * refusal answered before the job existed) the message is the ONLY diagnostic
 * and passes through untouched — which is what keeps `export.spec.ts`'s
 * "names the cause" assertion true.
 *
 * Bullet lines are matched at the start of a line, so a message whose own prose
 * happens to contain a dash mid-sentence is not eaten.
 */
export function summariseFailureMessage(message: string, structuredReportShown: boolean): string {
  if (!structuredReportShown) return message;
  const kept = message
    .split("\n")
    .filter((line) => !/^\s*-\s/.test(line))
    .join("\n")
    .trim();
  // A message that was NOTHING BUT bullets would otherwise render as an empty
  // paragraph, which reads as a missing message rather than as a de-duplicated
  // one.
  return kept === "" ? message : kept;
}

export default function ExportPanel({
  outcome,
  downloadUrl,
  onClose,
  onRetry,
  canvasRoutes,
}: ExportPanelProps) {
  const [tab, setTab] = useState<"files" | "handover">("files");
  const tree = useMemo(
    () => buildFileTree(outcome.ok ? outcome.files : []),
    [outcome],
  );

  if (!outcome.ok) {
    const failedGates = outcome.gateReport?.gates.filter((gate) => !gate.passed) ?? [];
    // DOGFOOD G3. `blocked` is "generated, but not exportable" — a state with
    // no retry, because no action in this editor can change the answer.
    const shape = classifyExportFailure(outcome);
    const blocked = shape.kind === "blocked";
    return (
      <div data-testid="export-panel" className="export-panel export-panel-failed">
        <div className="export-panel-head">
          {blocked ? (
            <h2 data-testid="export-blocked-title">{BLOCKED_TITLE}</h2>
          ) : (
            <h2 data-testid="export-failed-title">Export failed — nothing was shipped</h2>
          )}
          <button type="button" data-testid="export-close" onClick={onClose}>
            Close
          </button>
        </div>

        {blocked && (
          <div className="export-blocked" data-testid="export-blocked">
            <p data-testid="export-blocked-explanation">{BLOCKED_EXPLANATION}</p>
            {/* The sentence that stands in for the button that used to be here.
                It is stated rather than merely implied by the button's absence:
                a tester who has seen "Try export again" once will look for it. */}
            <p data-testid="export-blocked-verdict">
              <strong>{BLOCKED_VERDICT}</strong>
            </p>
            <p data-testid="export-blocked-remedy">
              {describeBlockedRemedy(shape.routes, canvasRoutes)}
            </p>
          </div>
        )}

        {/* G8: the same violations used to appear here as prose AND below as a
            structured report. The headline survives; the bullets do not, unless
            they are the only diagnostic there is. */}
        <p className="export-failed-message" data-testid="export-failure-message">
          {summariseFailureMessage(outcome.message, failedGates.length > 0)}
        </p>

        {failedGates.length > 0 && (
          <div data-testid="export-gate-report" className="export-gate-report">
            {failedGates.map((gate) => (
              <div key={gate.gate} className="export-gate">
                <h3>
                  Gate {gate.gate} — {gate.name}
                </h3>
                <ul>
                  {gate.failures.map((failure, index) => (
                    <li key={`${failure.reason}-${String(index)}`}>
                      {failure.file !== undefined && (
                        <code>
                          {failure.file}
                          {failure.line === undefined ? "" : `:${String(failure.line)}`}
                        </code>
                      )}
                      <span>{failure.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {outcome.buildLog !== undefined && (
          <pre data-testid="export-build-log" className="export-build-log">
            {outcome.buildLog.trim()}
          </pre>
        )}

        {/* NO RETRY IN THE BLOCKED CASE. The button is not disabled, hidden
            behind a tooltip, or relabelled: it is absent, because there is no
            state of this project in which pressing it helps. */}
        {!blocked && (
          <div className="export-actions">
            <button type="button" data-testid="export-retry" onClick={onRetry}>
              Try export again
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-testid="export-panel" className="export-panel">
      <div className="export-panel-head">
        <h2 data-testid="export-success-title">Export ready</h2>
        <button type="button" data-testid="export-close" onClick={onClose}>
          Close
        </button>
      </div>

      <p className="export-summary" data-testid="export-summary">
        {outcome.files.length} files · {outcome.appliedOverrides} edit
        {outcome.appliedOverrides === 1 ? "" : "s"} compiled in · {outcome.integrationCount} integration
        TODO{outcome.integrationCount === 1 ? "" : "s"} · {outcome.offScaleCount} off-scale override
        {outcome.offScaleCount === 1 ? "" : "s"}
      </p>

      <a
        className="export-download"
        data-testid="export-download"
        href={downloadUrl}
        download={outcome.zipName}
      >
        Download {outcome.zipName} ({formatBytes(outcome.zipBytes)})
      </a>

      <div className="export-tabs" role="group" aria-label="Export preview">
        <button
          type="button"
          data-testid="export-tab-files"
          className={tab === "files" ? "active" : ""}
          aria-pressed={tab === "files"}
          onClick={() => setTab("files")}
        >
          Files
        </button>
        <button
          type="button"
          data-testid="export-tab-handover"
          className={tab === "handover" ? "active" : ""}
          aria-pressed={tab === "handover"}
          onClick={() => setTab("handover")}
        >
          HANDOVER.md
        </button>
      </div>

      {tab === "files" ? (
        <div data-testid="export-file-tree" className="export-file-tree">
          <FileTree node={tree} depth={0} />
        </div>
      ) : (
        <pre data-testid="export-handover" className="export-handover">
          {outcome.handover}
        </pre>
      )}
    </div>
  );
}
