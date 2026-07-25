import { useEffect, useRef, useState } from "react";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type {
  NodeGeometry,
  ShimToParentMessage,
} from "@website-generator/compiler/src/shim/protocol.ts";
import { PROTOCOL_VERSION } from "@website-generator/compiler/src/shim/protocol.ts";
import { breadcrumbFor, humanizeSegment, parentNodeId } from "./lib/labels";
import "./App.css";

// guarded: unit tests import this module in a windowless environment
const PREVIEW_URL =
  typeof window === "undefined"
    ? "http://localhost:5273"
    : (new URLSearchParams(window.location.search).get("preview") ?? "http://localhost:5273");

type Rect = NodeGeometry["rect"];
type ShimStatus = "connecting" | "ready" | "version-mismatch";

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

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [geometry, setGeometry] = useState<Record<string, Rect>>({});
  const [hoverId, setHoverId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [shimStatus, setShimStatus] = useState<ShimStatus>("connecting");
  const manifestRef = useRef<Manifest | null>(null);

  useEffect(() => {
    void fetch(`${PREVIEW_URL}/manifest.json`)
      .then((response) => response.json())
      .then((loaded: Manifest) => {
        manifestRef.current = loaded;
        setManifest(loaded);
      });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as ShimToParentMessage | null | undefined;
      if (data === null || data === undefined || typeof data !== "object") return;
      switch (data.type) {
        case "frame:ready":
          setShimStatus(data.protocolVersion === PROTOCOL_VERSION ? "ready" : "version-mismatch");
          break;
        case "nodes:geometry":
          setGeometry(Object.fromEntries(data.nodes.map((node) => [node.nodeId, node.rect])));
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setSelectedId((previous) => {
        if (previous === undefined || manifestRef.current === null) return undefined;
        return parentNodeId(previous, manifestRef.current);
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const crumbs = manifest === null ? [] : breadcrumbFor(selectedId, manifest);
  const selectedNode = selectedId !== undefined ? manifest?.nodes[selectedId] : undefined;
  const selectedRect = selectedId !== undefined ? geometry[selectedId] : undefined;
  const hoverRect =
    hoverId !== undefined && hoverId !== selectedId ? geometry[hoverId] : undefined;

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
        {shimStatus === "version-mismatch" && (
          <span data-testid="version-warning" className="version-warning">
            Preview shim protocol mismatch — rebuild the preview.
          </span>
        )}
      </header>

      <div className="editor-main">
        <div className="stage" onMouseLeave={() => setHoverId(undefined)}>
          <div className="frame-wrap">
            <iframe title="preview" src={PREVIEW_URL} className="preview-frame" />
            <div className="overlay">
              {hoverRect !== undefined && hoverId !== undefined && (
                <div
                  data-testid="hover-outline"
                  className="hover-outline"
                  style={{
                    left: hoverRect.x,
                    top: hoverRect.y,
                    width: hoverRect.width,
                    height: hoverRect.height,
                  }}
                >
                  <span data-testid="hover-label" className="hover-label">
                    {humanizeSegment(hoverId.split(".").pop()!)}
                  </span>
                </div>
              )}
              {selectedRect !== undefined && (
                <div
                  data-testid="selection-outline"
                  className="selection-outline"
                  style={{
                    left: selectedRect.x,
                    top: selectedRect.y,
                    width: selectedRect.width,
                    height: selectedRect.height,
                  }}
                >
                  {HANDLES.map((handle) => (
                    <span key={handle} className={`handle handle-${handle}`} />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="inspector" data-testid="inspector">
          {selectedNode !== undefined && selectedId !== undefined ? (
            <>
              <h2 className="inspector-heading">{humanizeSegment(selectedId.split(".").pop()!)}</h2>
              <code className="inspector-id">{selectedId}</code>
              <dl className="inspector-meta">
                <dt>Element</dt>
                <dd>{selectedNode.element}</dd>
              </dl>
              <h3 className="inspector-subheading">Editable channels</h3>
              <div>
                {selectedNode.editable.map((channel) => (
                  <span key={channel} data-testid="channel-badge" className="badge">
                    {channel}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="inspector-empty">Click an element in the preview to select it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
