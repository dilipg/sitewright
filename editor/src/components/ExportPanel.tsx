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

export default function ExportPanel({ outcome, downloadUrl, onClose, onRetry }: ExportPanelProps) {
  const [tab, setTab] = useState<"files" | "handover">("files");
  const tree = useMemo(
    () => buildFileTree(outcome.ok ? outcome.files : []),
    [outcome],
  );

  if (!outcome.ok) {
    const failedGates = outcome.gateReport?.gates.filter((gate) => !gate.passed) ?? [];
    return (
      <div data-testid="export-panel" className="export-panel export-panel-failed">
        <div className="export-panel-head">
          <h2 data-testid="export-failed-title">Export failed — nothing was shipped</h2>
          <button type="button" data-testid="export-close" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="export-failed-message" data-testid="export-failure-message">
          {outcome.message}
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

        <div className="export-actions">
          <button type="button" data-testid="export-retry" onClick={onRetry}>
            Try export again
          </button>
        </div>
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
