import { useEffect, useRef, useState } from "react";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type {
  NodeGeometry,
  ShimOverride,
  ShimToParentMessage,
} from "@website-generator/compiler/src/shim/protocol.ts";
import { PROTOCOL_VERSION } from "@website-generator/compiler/src/shim/protocol.ts";
import Inspector from "./components/Inspector";
import { expandStyleValue } from "./lib/inventory";
import { breadcrumbFor, humanizeSegment, parentNodeId } from "./lib/labels";
import type { History, OverridesMap } from "./lib/store";
import {
  applyStyleProperty,
  currentSnapshot,
  fromOverrideFile,
  initHistory,
  pushHistory,
  redo,
  toOverrideFile,
  undo,
} from "./lib/store";
import type { TokensJson } from "./lib/tokens";
import { tokenPathSet } from "./lib/tokens";
import "./App.css";

// guarded: unit tests import this module in a windowless environment
const PREVIEW_URL =
  typeof window === "undefined"
    ? "http://localhost:5273"
    : (new URLSearchParams(window.location.search).get("preview") ?? "http://localhost:5273");

type ShimStatus = "connecting" | "ready" | "version-mismatch";
type SaveStatus = "Loading…" | "Saving…" | "Saved";

/** Nearest active manifest node at or above the given ID. */
function selectableId(nodeId: string, manifest: Manifest | null): string | undefined {
  if (manifest === null) return undefined;
  let current: string | undefined = nodeId;
  while (current !== undefined) {
    if (manifest.nodes[current]?.status === "active") return current;
    current = current.includes(".") ? current.slice(0, current.lastIndexOf(".")) : undefined;
  }
  return undefined;
}

/** Persisted entries -> shim message list, with variant choices expanded to declarations. */
function expandForShim(map: OverridesMap, manifest: Manifest | null): ShimOverride[] {
  const overrides: ShimOverride[] = [];
  for (const [nodeId, channels] of Object.entries(map)) {
    for (const [channel, value] of Object.entries(channels)) {
      if (value === undefined) continue;
      if (channel === "style") {
        const element = manifest?.nodes[nodeId]?.element ?? "";
        overrides.push({
          nodeId,
          channel,
          value: expandStyleValue(value as Record<string, unknown>, element),
        });
      } else {
        overrides.push({ nodeId, channel: channel as ShimOverride["channel"], value });
      }
    }
  }
  return overrides;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [tokens, setTokens] = useState<TokensJson | null>(null);
  const [geometry, setGeometry] = useState<Record<string, NodeGeometry>>({});
  const [hoverId, setHoverId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [shimStatus, setShimStatus] = useState<ShimStatus>("connecting");
  const [history, setHistory] = useState<History | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("Loading…");

  const manifestRef = useRef<Manifest | null>(null);
  const historyRef = useRef<History | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const hydratedRef = useRef(false);
  historyRef.current = history;

  const map = history !== null ? currentSnapshot(history) : {};
  const routeSlug = manifest !== null ? Object.keys(manifest.nodes)[0]?.split(".")[0] : undefined;

  /* ---------- bootstrap: manifest, tokens, persisted overrides + history ---------- */

  useEffect(() => {
    async function bootstrap() {
      const [manifestJson, tokensJson] = await Promise.all([
        fetch(`${PREVIEW_URL}/manifest.json`).then((r) => r.json() as Promise<Manifest>),
        fetch(`${PREVIEW_URL}/src/tokens/tokens.json`).then((r) => r.json() as Promise<TokensJson>),
      ]);
      manifestRef.current = manifestJson;
      setManifest(manifestJson);
      setTokens(tokensJson);

      const slug = Object.keys(manifestJson.nodes)[0]?.split(".")[0] ?? "home";
      const [overrideFile, historyFile] = await Promise.all([
        fetch(`${PREVIEW_URL}/__overrides/${slug}`).then((r) => r.json()),
        fetch(`${PREVIEW_URL}/__overrides-history`).then((r) => r.json()),
      ]);
      const persisted =
        Array.isArray(historyFile?.snapshots) && typeof historyFile.index === "number"
          ? { snapshots: historyFile.snapshots as OverridesMap[], index: historyFile.index as number }
          : initHistory(fromOverrideFile(overrideFile));
      setHistory(persisted);
      setSaveStatus("Saved");
      hydratedRef.current = true;
    }
    void bootstrap();
  }, []);

  /* ---------- shim messages ---------- */

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as ShimToParentMessage | null | undefined;
      if (data === null || data === undefined || typeof data !== "object") return;
      switch (data.type) {
        case "frame:ready":
          setShimStatus(data.protocolVersion === PROTOCOL_VERSION ? "ready" : "version-mismatch");
          break;
        case "nodes:geometry":
          setGeometry(Object.fromEntries(data.nodes.map((node) => [node.nodeId, node])));
          break;
        case "node:hit": {
          const resolved = selectableId(data.nodeId, manifestRef.current);
          if (data.kind === "click") {
            if (resolved !== undefined) setSelectedId(resolved);
            // reclaim keyboard focus from the cross-origin frame so Esc works
            window.focus();
          } else {
            setHoverId(resolved);
          }
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /* ---------- keyboard: Esc walks up, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y ---------- */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedId((previous) => {
          if (previous === undefined || manifestRef.current === null) return undefined;
          return parentNodeId(previous, manifestRef.current);
        });
        return;
      }
      const undoKey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
      const redoKey =
        (event.ctrlKey || event.metaKey) &&
        (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey));
      if (redoKey) {
        event.preventDefault();
        setHistory((h) => (h === null ? h : redo(h)));
      } else if (undoKey) {
        event.preventDefault();
        setHistory((h) => (h === null ? h : undo(h)));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* ---------- live application through overrides:apply ---------- */

  useEffect(() => {
    if (shimStatus !== "ready" || history === null) return;
    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "overrides:apply",
        protocolVersion: PROTOCOL_VERSION,
        overrides: expandForShim(map, manifest),
      },
      "*",
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, shimStatus]);

  /* ---------- debounced persistence (overrides file + history file) ---------- */

  useEffect(() => {
    if (!hydratedRef.current || history === null || routeSlug === undefined) return;
    setSaveStatus("Saving…");
    const routePath = manifest?.nodes[Object.keys(manifest.nodes)[0]!]?.route ?? "/";
    const timer = setTimeout(() => {
      void (async () => {
        await fetch(`${PREVIEW_URL}/__overrides/${routeSlug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toOverrideFile(map, routePath)),
        });
        await fetch(`${PREVIEW_URL}/__overrides-history`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: 1, snapshots: history.snapshots, index: history.index }),
        });
        setSaveStatus("Saved");
      })();
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  /* ---------- edits ---------- */

  function commitStyle(property: string, value: string) {
    if (selectedId === undefined) return;
    setHistory((h) => {
      if (h === null) return h;
      return pushHistory(h, applyStyleProperty(currentSnapshot(h), selectedId, property, value));
    });
  }

  const crumbs = manifest === null ? [] : breadcrumbFor(selectedId, manifest);
  const selectedNode = selectedId !== undefined ? manifest?.nodes[selectedId] : undefined;
  const selectedGeom = selectedId !== undefined ? geometry[selectedId] : undefined;
  const hoverGeom = hoverId !== undefined && hoverId !== selectedId ? geometry[hoverId] : undefined;
  const selectedStyle =
    selectedId !== undefined
      ? ((map[selectedId]?.style as Record<string, string> | undefined) ?? {})
      : {};

  return (
    <div className="editor-root">
      <header className="editor-header">
        <span className="editor-title">Website Generator</span>
        <nav data-testid="breadcrumb" className="breadcrumb" aria-label="Selection breadcrumb">
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <span key={crumb.nodeId ?? "page"} className="crumb">
                {index > 0 && <span className="crumb-sep">›</span>}
                {isLast && crumb.nodeId !== undefined ? (
                  <span className="crumb-current">{crumb.label}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedId(
                        crumb.nodeId === undefined
                          ? undefined
                          : selectableId(crumb.nodeId, manifest),
                      )
                    }
                  >
                    {crumb.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <div className="header-actions">
          <button
            type="button"
            data-testid="undo-button"
            disabled={history === null || history.index === 0}
            onClick={() => setHistory((h) => (h === null ? h : undo(h)))}
          >
            Undo
          </button>
          <button
            type="button"
            data-testid="redo-button"
            disabled={history === null || history.index >= history.snapshots.length - 1}
            onClick={() => setHistory((h) => (h === null ? h : redo(h)))}
          >
            Redo
          </button>
          <span data-testid="save-status" className="save-status">
            {saveStatus}
          </span>
        </div>
        {shimStatus === "version-mismatch" && (
          <span data-testid="version-warning" className="version-warning">
            Preview shim protocol mismatch — rebuild the preview.
          </span>
        )}
      </header>

      <div className="editor-main">
        <div className="stage" onMouseLeave={() => setHoverId(undefined)}>
          <div className="frame-wrap">
            <iframe ref={iframeRef} title="preview" src={PREVIEW_URL} className="preview-frame" />
            <div className="overlay">
              {hoverGeom !== undefined && hoverId !== undefined && (
                <div
                  data-testid="hover-outline"
                  className="hover-outline"
                  style={{
                    left: hoverGeom.rect.x,
                    top: hoverGeom.rect.y,
                    width: hoverGeom.rect.width,
                    height: hoverGeom.rect.height,
                  }}
                >
                  <span data-testid="hover-label" className="hover-label">
                    {humanizeSegment(hoverId.split(".").pop()!)}
                  </span>
                </div>
              )}
              {selectedGeom !== undefined && (
                <>
                  <div
                    data-testid="spacing-overlay"
                    className="spacing-overlay"
                    style={{
                      left: selectedGeom.rect.x,
                      top: selectedGeom.rect.y,
                      width: selectedGeom.rect.width,
                      height: selectedGeom.rect.height,
                    }}
                  >
                    <span className="pad-band" style={{ top: 0, left: 0, right: 0, height: selectedGeom.spacing.padding.top }} />
                    <span className="pad-band" style={{ bottom: 0, left: 0, right: 0, height: selectedGeom.spacing.padding.bottom }} />
                    <span className="pad-band" style={{ top: 0, bottom: 0, left: 0, width: selectedGeom.spacing.padding.left }} />
                    <span className="pad-band" style={{ top: 0, bottom: 0, right: 0, width: selectedGeom.spacing.padding.right }} />
                    <span className="margin-band" style={{ top: -selectedGeom.spacing.margin.top, left: 0, right: 0, height: selectedGeom.spacing.margin.top }} />
                    <span className="margin-band" style={{ bottom: -selectedGeom.spacing.margin.bottom, left: 0, right: 0, height: selectedGeom.spacing.margin.bottom }} />
                  </div>
                  <div
                    data-testid="selection-outline"
                    className="selection-outline"
                    style={{
                      left: selectedGeom.rect.x,
                      top: selectedGeom.rect.y,
                      width: selectedGeom.rect.width,
                      height: selectedGeom.rect.height,
                    }}
                  >
                    {HANDLES.map((handle) => (
                      <span key={handle} className={`handle handle-${handle}`} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <aside className="inspector" data-testid="inspector">
          {selectedNode !== undefined && selectedId !== undefined && tokens !== null ? (
            <Inspector
              nodeId={selectedId}
              node={selectedNode}
              tokens={tokens}
              tokenPaths={tokenPathSet(tokens)}
              styleValue={selectedStyle}
              onCommit={commitStyle}
            />
          ) : (
            <p className="inspector-empty">Click an element in the preview to select it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
