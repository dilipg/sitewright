import { useEffect, useMemo, useRef, useState } from "react";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type {
  NodeGeometry,
  ShimOverride,
  ShimToParentMessage,
} from "@website-generator/compiler/src/shim/protocol.ts";
import { PROTOCOL_VERSION } from "@website-generator/compiler/src/shim/protocol.ts";
import type { ExportOutcome } from "./components/ExportPanel";
import ExportPanel from "./components/ExportPanel";
import Inspector from "./components/Inspector";
import type { PlanBrief, PlanRoute } from "./components/PlanApproval";
import PlanApproval from "./components/PlanApproval";
import type { AddSectionState, Archetype } from "./components/AddSection";
import { AddSectionPanel } from "./components/AddSection";
import type { EditPromptState } from "./components/EditPrompt";
import EditPrompt from "./components/EditPrompt";
import type { RegenPhase } from "./components/Regen";
import { OrphanDialog, RegenControls } from "./components/Regen";
import type { PreviewWidth, RouteInfo, Viewport } from "./lib/canvas";
import {
  clampZoom,
  FRAME_GAP,
  FRAME_WIDTH,
  frameOffsetX,
  isEditableWidth,
  PREVIEW_WIDTHS,
  isFrameNearViewport,
  renderedSections,
  routesFromManifest,
  splitOverridesByRoute,
  zoomAt,
} from "./lib/canvas";
import { applyEditOperations, interpretEditResult, validateEditOperations } from "./lib/edit-ops";
import type { EditPromptResponse } from "./lib/edit-ops";
import { expandStyleValue } from "./lib/inventory";
import { enqueueAndPoll, formatElapsedSeconds } from "./lib/jobs";
import { breadcrumbFor, humanizeSegment, parentNodeId } from "./lib/labels";
import type { History, OverridesMap } from "./lib/store";
import {
  applyLayoutProperty,
  applyStyleProperty,
  applyTextValue,
  isKeyedTextValue,
  applyVisibility,
  currentSnapshot,
  fromOverrideFile,
  initHistory,
  moveSection,
  placeSectionAfter,
  pushHistory,
  redo,
  removeNodeOverrides,
  sectionOrderOf,
  toOverrideFile,
  undo,
} from "./lib/store";
import type { TokensJson } from "./lib/tokens";
import { nearestSpaceStep, tokenPathSet } from "./lib/tokens";
import "./App.css";

// guarded: unit tests import this module in a windowless environment
const PREVIEW_URL =
  typeof window === "undefined"
    ? "http://localhost:5273"
    : (new URLSearchParams(window.location.search).get("preview") ?? "http://localhost:5273");

type ShimStatus = "connecting" | "ready" | "version-mismatch";
type SaveStatus = "Loading…" | "Saving…" | "Saved";

/** Canned planner brief for the walking skeleton's single hero section
 * (real briefs arrive with the Site Planner in M5). */
const CANNED_SECTION_BRIEF =
  "Bold opening hero introducing the product with a primary trial CTA and a secondary demo CTA.";

/** Nominal frame height on the canvas (PRD 2.1: frames render at desktop
 * width in v1) — generous enough that typical pages don't need internal
 * iframe scrolling to reach their footer. */
const FRAME_HEIGHT = 2000;
const ZOOM_WHEEL_SENSITIVITY = 0.002;

/**
 * Shown for any job that reaches `interrupted` (slice 5, job model): the
 * server restarted mid-run and genuinely cannot tell whether the work
 * finished — a subprocess mid-`write_section_only` may have left a
 * half-written page (job-model design doc's own "Crash recovery" section).
 * Reporting this as "failed" would be a lie a user could act on (e.g.
 * resubmitting and paying twice for work that already landed), so it gets
 * its own honest message rather than being folded into any flow's existing
 * failure phase.
 */
const JOB_INTERRUPTED_MESSAGE =
  "The server restarted while this was running, so the outcome is unknown. Check the page to see whether the change went through before trying again.";

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

/** Node ids are globally unique and route-slug-prefixed (contract 5.2) — the
 * route a node belongs to is always recoverable from its own id. */
function routeOf(nodeId: string): string {
  return nodeId.split(".")[0]!;
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
      } else if (channel === "text" && isKeyedTextValue(value)) {
        // image replace (PRD 3.5): the key tells the shim to set that
        // attribute rather than the node's text content
        overrides.push({ nodeId, channel: "text", key: value.key, value: value.value });
      } else {
        overrides.push({ nodeId, channel: channel as ShimOverride["channel"], value });
      }
    }
  }
  return overrides;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

/** Which dimension each resize handle drives, and in which drag direction it grows (PRD 3.3). */
const HANDLE_DELTA: Record<Handle, { width: number; height: number }> = {
  n: { width: 0, height: -1 },
  s: { width: 0, height: 1 },
  e: { width: 1, height: 0 },
  w: { width: -1, height: 0 },
  ne: { width: 1, height: -1 },
  nw: { width: -1, height: -1 },
  se: { width: 1, height: 1 },
  sw: { width: -1, height: 1 },
};

const MIN_SIZE_PX = 20;
// Beyond this, a drag reads as an attempted reparent/reorder, which v1 does
// not support (contract 6.1: layout edits are size/position DELTAS only,
// PRD risk 3.3) — constrain the gesture visually instead of applying it.
const REJECT_THRESHOLD_PX = 200;
const REJECTED_GESTURE_HINT = "Regenerate the section to change its structure";

export default function App() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [tokens, setTokens] = useState<TokensJson | null>(null);
  const [geometryByRoute, setGeometryByRoute] = useState<Record<string, Record<string, NodeGeometry>>>({});
  const [hoverId, setHoverId] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editingDraft, setEditingDraft] = useState("");
  const [dragGhost, setDragGhost] = useState<{ rect: NodeGeometry["rect"]; rejected: boolean } | null>(
    null,
  );
  const [gestureToast, setGestureToast] = useState<string>();
  const [previewMode, setPreviewModeState] = useState<"edit" | "interact">("edit");
  const [previewWidth, setPreviewWidth] = useState<PreviewWidth>("desktop");
  const [frameStatus, setFrameStatus] = useState<Record<string, ShimStatus>>({});
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, zoom: 1 });
  const [stageSize, setStageSize] = useState({ width: 1200, height: 800 });
  const [history, setHistory] = useState<History | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("Loading…");
  const [regen, setRegen] = useState<RegenPhase>({ phase: "idle" });
  const [orphans, setOrphans] = useState<string[]>([]);
  const [revertSection, setRevertSection] = useState<string>();
  const [frameReadySeq, setFrameReadySeq] = useState(0);
  const [pendingPlan, setPendingPlan] = useState<{ brief: PlanBrief; routes: PlanRoute[] } | null>(
    null,
  );
  const [addSection, setAddSection] = useState<AddSectionState | null>(null);
  const [archetypes, setArchetypes] = useState<Archetype[]>([]);
  const [exportState, setExportState] = useState<"idle" | "running">("idle");
  const [exportOutcome, setExportOutcome] = useState<ExportOutcome | null>(null);
  const [editPrompt, setEditPrompt] = useState<EditPromptState>({ phase: "idle" });
  const [editDraft, setEditDraft] = useState("");
  // Elapsed time for the two job-backed operations whose progress display
  // lives entirely in App.tsx (regen's in-canvas overlay, the export
  // button's own label) — a job is opaque until it finishes, so this is the
  // only honest thing to show while one is in flight (slice 5, job model).
  // editPrompt's and addSection's own elapsedMs live inside their phase
  // objects instead, since their "running" text is rendered by their own
  // components.
  const [regenElapsedMs, setRegenElapsedMs] = useState(0);
  const [exportElapsedMs, setExportElapsedMs] = useState(0);
  // A job that comes back `interrupted` (server restarted mid-run) is not a
  // failure and must not be reported as one (JOB_INTERRUPTED_MESSAGE) — this
  // banner is the one honest surface for it, shared by all five flows
  // rather than overloading each flow's own "failed" phase, which every
  // component already renders with failure-specific language ("Regeneration
  // failed", "Export failed — nothing was shipped") that would be untrue here.
  const [jobNotice, setJobNotice] = useState<string | undefined>(undefined);

  const manifestRef = useRef<Manifest | null>(null);
  const historyRef = useRef<History | null>(null);
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const editOverlayRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hydratedRef = useRef(false);
  const widthEditableRef = useRef(true);
  // Real wall-clock baselines for the elapsed-time displays below (task-4
  // review): a tick that just adds 1000ms to the last displayed value drifts
  // under background-tab throttling, where the browser can clamp
  // `setInterval` to well over 1s per fire — so ONE tick that fired late
  // silently makes every number after it wrong, forever, for that run. Each
  // ref is stamped with `Date.now()` at the exact moment its flow enters
  // `running`; every tick recomputes fresh from it (`Date.now() -
  // ref.current`), so a late-firing interval only delays the NEXT update,
  // it never compounds an error into the ones already shown.
  const regenStartedAtRef = useRef<number | undefined>(undefined);
  const exportStartedAtRef = useRef<number | undefined>(undefined);
  const editPromptStartedAtRef = useRef<number | undefined>(undefined);
  const addSectionStartedAtRef = useRef<number | undefined>(undefined);
  // Bootstrap's own setHistory(persisted) is itself a `history` change, so
  // it would otherwise trigger the persistence effect below to immediately
  // write the just-loaded data straight back — a redundant "startup save"
  // racing the very first real edit. If that edit's click lands more than
  // 300ms after hydration (routine under load), both saves are in flight
  // together, and whichever settles last wins on disk — sometimes the
  // stale pre-edit one, silently dropping the edit. Skipping the effect for
  // exactly this one, first post-hydration render removes the race instead
  // of trying to out-race it.
  const skipNextSaveRef = useRef(false);
  historyRef.current = history;
  widthEditableRef.current = isEditableWidth(previewWidth);

  const map = history !== null ? currentSnapshot(history) : {};
  const routes = useMemo<RouteInfo[]>(() => (manifest === null ? [] : routesFromManifest(manifest)), [manifest]);
  const geometry = useMemo<Record<string, NodeGeometry>>(
    () => Object.assign({}, ...Object.values(geometryByRoute)) as Record<string, NodeGeometry>,
    [geometryByRoute],
  );

  /* ---------- stage size (drives virtualization) ---------- */

  useEffect(() => {
    const element = stageRef.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ---------- bootstrap: manifest, tokens, persisted overrides + history ---------- */

  useEffect(() => {
    async function bootstrap() {
      // an unapproved plan gates the whole editor (generation spend gate)
      const plan = (await fetch(`${PREVIEW_URL}/__plan`, { cache: "no-store" }).then((r) =>
        r.json(),
      )) as { exists: boolean; approved: boolean; brief?: PlanBrief; siteplan?: { routes: PlanRoute[] } };
      if (plan.exists && !plan.approved && plan.brief !== undefined && plan.siteplan !== undefined) {
        setPendingPlan({ brief: plan.brief, routes: plan.siteplan.routes });
      }

      const [manifestJson, tokensJson] = await Promise.all([
        fetch(`${PREVIEW_URL}/manifest.json`).then((r) => r.json() as Promise<Manifest>),
        fetch(`${PREVIEW_URL}/src/tokens/tokens.json`).then((r) => r.json() as Promise<TokensJson>),
      ]);
      manifestRef.current = manifestJson;
      setManifest(manifestJson);
      setTokens(tokensJson);

      const routeList = routesFromManifest(manifestJson);
      const [overrideFiles, historyFile] = await Promise.all([
        Promise.all(
          routeList.map((route) => fetch(`${PREVIEW_URL}/__overrides/${route.slug}`).then((r) => r.json())),
        ),
        fetch(`${PREVIEW_URL}/__overrides-history`).then((r) => r.json()),
      ]);
      const mergedOverrides: OverridesMap = Object.assign({}, ...overrideFiles.map(fromOverrideFile));
      const persisted =
        Array.isArray(historyFile?.snapshots) && typeof historyFile.index === "number"
          ? { snapshots: historyFile.snapshots as OverridesMap[], index: historyFile.index as number }
          : initHistory(mergedOverrides);
      skipNextSaveRef.current = true;
      setHistory(persisted);
      setSaveStatus("Saved");
      hydratedRef.current = true;
    }
    void bootstrap();
  }, []);

  /* ---------- shim messages (multiple cross-origin iframes, one per route) ---------- */

  useEffect(() => {
    function slugForSource(source: MessageEventSource | null): string | undefined {
      return Object.entries(iframeRefs.current).find(([, el]) => el?.contentWindow === source)?.[0];
    }
    function onMessage(event: MessageEvent) {
      const data = event.data as ShimToParentMessage | null | undefined;
      if (data === null || data === undefined || typeof data !== "object") return;
      switch (data.type) {
        case "frame:ready": {
          const slug = slugForSource(event.source);
          if (slug === undefined) break;
          setFrameStatus((prev) => ({
            ...prev,
            [slug]: data.protocolVersion === PROTOCOL_VERSION ? "ready" : "version-mismatch",
          }));
          // regen/HMR reloads re-handshake: bump so overrides re-apply
          setFrameReadySeq((sequence) => sequence + 1);
          break;
        }
        case "nodes:geometry": {
          const slug = slugForSource(event.source);
          if (slug === undefined) break;
          setGeometryByRoute((prev) => ({
            ...prev,
            [slug]: Object.fromEntries(data.nodes.map((node) => [node.nodeId, node])),
          }));
          break;
        }
        case "node:hit": {
          // Read-only at narrow widths (PRD 7 P1): selecting would offer edits
          // that cannot be expressed per-breakpoint, so nothing is selectable.
          if (!widthEditableRef.current) break;
          const resolved = selectableId(data.nodeId, manifestRef.current);
          if (data.kind === "click") {
            if (resolved !== undefined) setSelectedId(resolved);
            // reclaim keyboard focus from the cross-origin frame so Esc works
            window.focus();
          } else if (data.kind === "dblclick") {
            const editable = resolved !== undefined && manifestRef.current?.nodes[resolved]?.editable.includes("text");
            if (resolved !== undefined && editable === true) {
              setSelectedId(resolved);
              setEditingId(resolved);
              setEditingDraft(data.text ?? "");
            }
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

  /* ---------- text edit overlay: uncontrolled contentEditable ---------- */

  // The overlay's content is set imperatively, ONCE per edit session, never
  // from `editingDraft` in JSX — a contentEditable whose children are driven
  // by React state resets the caret to the start on every keystroke (React
  // reconciles the text node fresh each render). onInput still tracks the
  // draft in state for commitTextEdit to read; it just never feeds back in.
  useEffect(() => {
    if (editingId === undefined) return;
    const node = editOverlayRef.current;
    if (node === null) return;
    node.textContent = editingDraft;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  /* ---------- live application through overrides:apply (broadcast to every ready frame) ---------- */

  useEffect(() => {
    if (history === null || routes.length === 0) return;
    const overrides = expandForShim(map, manifest);
    for (const route of routes) {
      if (frameStatus[route.slug] !== "ready") continue;
      iframeRefs.current[route.slug]?.contentWindow?.postMessage(
        { type: "overrides:apply", protocolVersion: PROTOCOL_VERSION, overrides },
        "*",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, frameStatus, frameReadySeq, routes]);

  /* ---------- debounced persistence (one overrides file per route + one history file) ---------- */

  useEffect(() => {
    if (!hydratedRef.current || history === null || routes.length === 0) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    setSaveStatus("Saving…");
    const grouped = splitOverridesByRoute(map, routes);
    const timer = setTimeout(() => {
      void (async () => {
        await writeOverrides(grouped, routes, history);
        setSaveStatus("Saved");
      })();
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  /* ---------- elapsed-time ticking for job-backed operations (slice 5, job model) ----------
   * A job is opaque until it finishes (design doc's "Accepted losses": no
   * fabricated percentage, no synthetic step count) — elapsed time is the
   * only honest thing left to show. Ticks once a second locally, which is
   * finer-grained than enqueueAndPoll's own ~2s poll cadence against the
   * hosted server, and is the ONLY source of movement at all against the
   * local/unauthenticated preview server (compiler/scripts/preview.ts),
   * which never enqueues a job and so never calls `onStatus`. Each tick
   * RECOMPUTES from its flow's own `Date.now()` baseline ref rather than
   * adding a fixed 1000ms — see the refs' own comment above for why an
   * additive tick drifts under background-tab throttling. */
  useEffect(() => {
    if (regen.phase !== "running") return;
    const interval = window.setInterval(() => {
      if (regenStartedAtRef.current !== undefined) setRegenElapsedMs(Date.now() - regenStartedAtRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [regen.phase]);

  useEffect(() => {
    if (exportState !== "running") return;
    const interval = window.setInterval(() => {
      if (exportStartedAtRef.current !== undefined) setExportElapsedMs(Date.now() - exportStartedAtRef.current);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [exportState]);

  useEffect(() => {
    if (editPrompt.phase !== "running") return;
    const interval = window.setInterval(() => {
      setEditPrompt((current) =>
        current.phase === "running" && editPromptStartedAtRef.current !== undefined
          ? { ...current, elapsedMs: Date.now() - editPromptStartedAtRef.current }
          : current,
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [editPrompt.phase]);

  useEffect(() => {
    if (addSection?.phase !== "running") return;
    const interval = window.setInterval(() => {
      setAddSection((current) =>
        current?.phase === "running" && addSectionStartedAtRef.current !== undefined
          ? { ...current, elapsedMs: Date.now() - addSectionStartedAtRef.current }
          : current,
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [addSection?.phase]);

  /** Writes the current override + history state through the preview server's
   * persistence endpoints. Shared by the debounced autosave above and
   * runExport's pre-export flush — the exporter reads overrides from DISK,
   * so an export racing the debounce would ship the previous state. */
  async function writeOverrides(
    grouped: Record<string, OverridesMap>,
    routeList: RouteInfo[],
    historyState: History,
  ): Promise<void> {
    await Promise.all(
      routeList.map((route) =>
        fetch(`${PREVIEW_URL}/__overrides/${route.slug}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toOverrideFile(grouped[route.slug] ?? {}, route.path)),
        }),
      ),
    );
    await fetch(`${PREVIEW_URL}/__overrides-history`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        snapshots: historyState.snapshots,
        index: historyState.index,
      }),
    });
  }

  /* ---------- edits ---------- */

  function commitStyle(property: string, value: string) {
    if (selectedId === undefined) return;
    setHistory((h) => {
      if (h === null) return h;
      return pushHistory(h, applyStyleProperty(currentSnapshot(h), selectedId, property, value));
    });
  }

  /** PRD 3.3: a reorder is a page-level override keyed by the route, so it
   *  writes the whole section order rather than touching the moved node. */
  function commitSectionMove(nodeId: string, direction: -1 | 1) {
    const route = nodeId.split(".")[0]!;
    if (manifest === null) return;
    const rendered = renderedSections(geometryByRoute[route] ?? {}, manifest, route);
    setHistory((h) => {
      if (h === null) return h;
      const previous = currentSnapshot(h);
      const next = moveSection(previous, route, rendered, nodeId, direction);
      return next === previous ? h : pushHistory(h, next);
    });
  }

  /** One prompt = one history entry. Nothing is applied unless every operation
   *  validates, so a compound instruction never half-lands. */
  async function submitEditPrompt() {
    const route = selectedId === undefined ? routes[0]?.slug : routeOf(selectedId);
    // `history` is guarded with the rest: during the bootstrap window it is
    // still null, and setHistory's own null check would then silently drop the
    // batch while this function went on to report phase "done" — success
    // reported, nothing applied.
    if (route === undefined || manifest === null || tokens === null || history === null) return;
    const instruction = editDraft;
    editPromptStartedAtRef.current = Date.now();
    // A stale interrupted-banner from an earlier run must not linger once
    // the user is visibly acting on this flow again (task-4 review).
    setJobNotice(undefined);
    setEditPrompt({ phase: "running", elapsedMs: 0 });
    try {
      const job = await enqueueAndPoll(
        `${PREVIEW_URL}/__edit-prompt`,
        { route, instruction, selection: selectedId },
        {
          onStatus: (update) =>
            setEditPrompt((current) =>
              current.phase === "running"
                ? { ...current, elapsedMs: Math.max(current.elapsedMs, update.elapsedMs) }
                : current,
            ),
        },
      );
      if (job.status === "interrupted") {
        setJobNotice(JOB_INTERRUPTED_MESSAGE);
        setEditPrompt({ phase: "idle" });
        return;
      }
      if (job.status === "failed") throw new Error(job.error ?? "unknown failure");
      // THE TRAP (jobs.ts's own header comment): "succeeded" means the
      // request completed, not that the edit was accepted — job.result is
      // verbatim the same body /__edit-prompt always returned, so it is
      // read exactly as it was before enqueueAndPoll existed.
      const outcome = interpretEditResult(job.result as EditPromptResponse);
      if (outcome.kind === "error") throw new Error(outcome.message);
      if (outcome.kind === "structural") {
        setEditPrompt({ phase: "structural", kind: outcome.structuralKind, reason: outcome.reason });
        return;
      }
      if (outcome.kind === "clarify") {
        setEditPrompt({ phase: "clarify", question: outcome.question });
        return;
      }
      const ops = outcome.operations;
      const errors = validateEditOperations(ops, manifest, tokenPathSet(tokens), route);
      if (errors.length > 0 || ops.length === 0) {
        setEditPrompt({ phase: "rejected", errors: errors.length > 0 ? errors : ["Nothing to change."] });
        return;
      }
      setHistory((h) => (h === null ? h : pushHistory(h, applyEditOperations(currentSnapshot(h), ops))));
      setEditDraft("");
      setEditPrompt({
        phase: "done",
        notes: outcome.notes,
        applied: ops.map((op) => `${op.op} ${op.nodeId ?? op.route ?? ""}`),
      });
    } catch (error) {
      setEditPrompt({ phase: "rejected", errors: [String(error)] });
    }
  }

  function toggleVisibility() {
    if (selectedId === undefined) return;
    setHistory((h) => {
      if (h === null) return h;
      const previous = currentSnapshot(h);
      const currentlyHidden = previous[selectedId]?.visibility === true;
      return pushHistory(h, applyVisibility(previous, selectedId, !currentlyHidden));
    });
  }

  /** PRD 2.2: interact mode lets the user try the page's real behavior with
   * editing disabled — the shim itself stops forwarding node hits once it's
   * not "edit" (so clicks navigate for real instead of selecting), but the
   * editor's own chrome (selection, hover, an in-progress text edit) is
   * stale the instant the mode changes and must be cleared explicitly. */
  function setPreviewMode(next: "edit" | "interact") {
    setPreviewModeState(next);
    if (next === "interact") {
      setSelectedId(undefined);
      setHoverId(undefined);
      setEditingId(undefined);
    }
    for (const frame of Object.values(iframeRefs.current)) {
      frame?.contentWindow?.postMessage(
        { type: "mode:set", protocolVersion: PROTOCOL_VERSION, mode: next },
        "*",
      );
    }
  }

  /** Enter/blur commits (PRD 3.1); an unchanged draft is a no-op, not a history entry. */
  function commitTextEdit() {
    const nodeId = editingId;
    setEditingId(undefined);
    if (nodeId === undefined) return;
    setHistory((h) => {
      if (h === null) return h;
      const previous = currentSnapshot(h);
      if ((previous[nodeId]?.text as string | undefined) === editingDraft) return h;
      return pushHistory(h, applyTextValue(previous, nodeId, editingDraft));
    });
  }

  function cancelTextEdit() {
    setEditingId(undefined);
  }

  /** One gesture (a move or a corner-handle resize can touch two properties
   * at once) is one history entry, not one per property. */
  function commitLayoutProperties(nodeId: string, properties: Record<string, string>) {
    setHistory((h) => {
      if (h === null) return h;
      let next = currentSnapshot(h);
      for (const [property, value] of Object.entries(properties)) {
        next = applyLayoutProperty(next, nodeId, property, value);
      }
      return pushHistory(h, next);
    });
  }

  function showGestureRejectedHint(nodeId: string, kind: "move" | "resize", rawDx: number, rawDy: number) {
    setGestureToast(REJECTED_GESTURE_HINT);
    window.setTimeout(() => setGestureToast((current) => (current === REJECTED_GESTURE_HINT ? undefined : current)), 2500);
    // roadmap signal (PRD risk 3.3): every rejected gesture is worth knowing
    // about when prioritizing v2's layout-channel expressiveness
    console.info("[layout] rejected gesture (exceeds v1's no-reparenting bound)", { nodeId, kind, rawDx, rawDy });
  }

  /** Drag-to-reposition (mousedown on the selection body) and resize-via-
   * handle (mousedown on a handle) share one gesture loop (PRD 3.3): track
   * the raw pixel delta, snap it to the space scale unless a modifier key is
   * held, preview it as a ghost rect, and on release either commit it as a
   * layout-channel override or reject it (PRD risk 3) if it exceeds the
   * bound that would imply reparenting/reordering, which v1 cannot express.
   *
   * Deltas are read from raw client-pixel movement and divided by the
   * canvas zoom factor — at zoom !== 1 a screen pixel of drag no longer
   * equals a document pixel of the (unscaled) iframe content. */
  function startLayoutDrag(
    event: React.PointerEvent<HTMLSpanElement>,
    nodeId: string,
    kind: "move" | "resize",
    handle?: Handle,
  ) {
    event.preventDefault();
    event.stopPropagation();
    const startRect = geometry[nodeId]?.rect;
    if (startRect === undefined || tokens === null) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const zoom = viewport.zoom;
    // Pointer capture, not a window-level listener: the cursor crosses over
    // the click-through overlay (pointer-events:none) and the cross-origin
    // iframe during a real drag, which would otherwise route move/up events
    // to whatever's underneath instead of back to this element.
    const target: HTMLSpanElement = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    function nextRect(rawDx: number, rawDy: number, snap: boolean): NodeGeometry["rect"] {
      const dx = snap ? nearestSpaceStep(tokens!, rawDx) : rawDx;
      const dy = snap ? nearestSpaceStep(tokens!, rawDy) : rawDy;
      if (kind === "move") {
        return { ...startRect!, x: startRect!.x + Math.max(0, dx), y: startRect!.y + Math.max(0, dy) };
      }
      const weight = HANDLE_DELTA[handle!];
      return {
        ...startRect!,
        width: Math.max(MIN_SIZE_PX, startRect!.width + weight.width * dx),
        height: Math.max(MIN_SIZE_PX, startRect!.height + weight.height * dy),
      };
    }

    function onPointerMove(moveEvent: PointerEvent) {
      const rawDx = (moveEvent.clientX - startX) / zoom;
      const rawDy = (moveEvent.clientY - startY) / zoom;
      const rejected = Math.abs(rawDx) > REJECT_THRESHOLD_PX || Math.abs(rawDy) > REJECT_THRESHOLD_PX;
      setDragGhost({
        rect: rejected ? startRect! : nextRect(rawDx, rawDy, !moveEvent.altKey),
        rejected,
      });
    }

    function onPointerUp(upEvent: PointerEvent) {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      setDragGhost(null);
      const rawDx = (upEvent.clientX - startX) / zoom;
      const rawDy = (upEvent.clientY - startY) / zoom;
      if (Math.abs(rawDx) > REJECT_THRESHOLD_PX || Math.abs(rawDy) > REJECT_THRESHOLD_PX) {
        // A big vertical drag of a SECTION used to be rejected as implied
        // reordering that v1 could not express (PRD risk 3). Now it can, so
        // the gesture becomes the reorder it always looked like — one step
        // per gesture, and only when the drag is clearly vertical, so a
        // diagonal fling is still a rejection rather than a surprise move.
        const direction: -1 | 1 = rawDy < 0 ? -1 : 1;
        if (
          kind === "move" &&
          Math.abs(rawDy) > Math.abs(rawDx) &&
          selectedSectionOrder !== undefined &&
          selectedSectionOrder.includes(nodeId) &&
          selectedSectionOrder[selectedSectionOrder.indexOf(nodeId) + direction] !== undefined
        ) {
          commitSectionMove(nodeId, direction);
          return;
        }
        showGestureRejectedHint(nodeId, kind, rawDx, rawDy);
        return;
      }
      const snap = !upEvent.altKey;
      const dx = snap ? nearestSpaceStep(tokens!, rawDx) : rawDx;
      const dy = snap ? nearestSpaceStep(tokens!, rawDy) : rawDy;
      if (dx === 0 && dy === 0) return; // no-op gesture, not a history entry
      if (kind === "move") {
        commitLayoutProperties(nodeId, {
          marginLeft: `${Math.max(0, dx)}px`,
          marginTop: `${Math.max(0, dy)}px`,
        });
      } else {
        const weight = HANDLE_DELTA[handle!];
        const properties: Record<string, string> = {};
        if (weight.width !== 0) {
          properties.width = `${Math.max(MIN_SIZE_PX, startRect.width + weight.width * dx)}px`;
        }
        if (weight.height !== 0) {
          properties.height = `${Math.max(MIN_SIZE_PX, startRect.height + weight.height * dy)}px`;
        }
        if (Object.keys(properties).length > 0) commitLayoutProperties(nodeId, properties);
      }
    }

    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
  }

  /* ---------- canvas pan/zoom (PRD 2.1: DOM-based, CSS-transformed stage) ---------- */

  /** Two-finger trackpad scroll / mouse wheel pans; Ctrl/Cmd+wheel (pinch on
   * most trackpads reports this way) zooms toward the cursor. */
  function onStageWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setViewport((v) => zoomAt(v, event.clientX - rect.left, event.clientY - rect.top, -event.deltaY * ZOOM_WHEEL_SENSITIVITY));
    } else {
      setViewport((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    }
  }

  /** Drag-to-pan from empty canvas background only — a click that starts on
   * a frame or its chrome is handled by that element (and stops propagation
   * where it needs to), so this only ever fires for genuine background drags. */
  function onStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startViewport = viewport;

    function onPointerMove(moveEvent: PointerEvent) {
      setViewport({
        ...startViewport,
        x: startViewport.x + (moveEvent.clientX - startX),
        y: startViewport.y + (moveEvent.clientY - startY),
      });
    }
    function onPointerUp(upEvent: PointerEvent) {
      target.releasePointerCapture(upEvent.pointerId);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
    }
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
  }

  /* ---------- regeneration (PRD section 4) ---------- */

  /** Returns the reloaded manifest as well as storing it: `manifest` is state,
   *  so a caller that needs the new nodes in the SAME tick (add-a-section, which
   *  must position a node the manifest only just gained) cannot read them from
   *  the closure it was called in. */
  async function refreshManifest(): Promise<Manifest> {
    const loaded = (await fetch(`${PREVIEW_URL}/manifest.json`, { cache: "no-store" }).then((r) =>
      r.json(),
    )) as Manifest;
    manifestRef.current = loaded;
    setManifest(loaded);
    return loaded;
  }

  /** Deterministic frame reload after regen/revert — HMR is not a reliable
   * carrier for whole-section rewrites; frame:ready re-applies overrides. */
  function reloadPreview(section: string) {
    const slug = routeOf(section);
    const frame = iframeRefs.current[slug];
    const routePath = routes.find((route) => route.slug === slug)?.path ?? "/";
    if (frame !== null && frame !== undefined) {
      frame.src = `${PREVIEW_URL}${routePath}?regen=${Date.now()}`;
    }
  }

  /* ---------- add-a-section (PRD 4.1) ---------- */

  /** Every insertion point on a route: one above the first section, one below
   *  each. Derived from live geometry so the strips follow the sections when a
   *  reorder moves them, rather than from the manifest, which records that a
   *  section exists but never where it sits. */
  function addSectionSlots(route: string): Array<{ afterSection: string | undefined; y: number }> {
    if (manifest === null || previewMode !== "edit") return [];
    const sections = renderedSections(geometryByRoute[route] ?? {}, manifest, route);
    if (sections.length === 0) return [];
    const boxes = sections.map((nodeId) => geometryByRoute[route]![nodeId]!);
    return [
      { afterSection: undefined, y: boxes[0]!.rect.y },
      ...sections.map((nodeId, index) => ({
        afterSection: nodeId,
        y: boxes[index]!.rect.y + boxes[index]!.rect.height,
      })),
    ];
  }

  function openAddSection(route: string, afterSection: string | undefined) {
    setAddSection({ phase: "picking", route, afterSection, instruction: "" });
    if (archetypes.length === 0) {
      void fetch(`${PREVIEW_URL}/__archetypes`)
        .then((response) => response.json() as Promise<{ archetypes?: Archetype[] }>)
        .then((body) => setArchetypes(body.archetypes ?? []))
        .catch(() => setArchetypes([]));
    }
  }

  async function confirmAddSection() {
    if (addSection?.phase !== "picking" || addSection.archetype === undefined) return;
    const { route, afterSection, archetype, instruction } = addSection;
    addSectionStartedAtRef.current = Date.now();
    setJobNotice(undefined);
    setAddSection({ phase: "running", route, elapsedMs: 0 });
    try {
      const job = await enqueueAndPoll(
        `${PREVIEW_URL}/__add-section`,
        { route, archetype, instruction },
        {
          onStatus: (update) =>
            setAddSection((current) =>
              current?.phase === "running"
                ? { ...current, elapsedMs: Math.max(current.elapsedMs, update.elapsedMs) }
                : current,
            ),
        },
      );
      if (job.status === "interrupted") {
        setJobNotice(JOB_INTERRUPTED_MESSAGE);
        setAddSection(null);
        return;
      }
      if (job.status === "failed") throw new Error(job.error ?? "unknown failure");
      // THE TRAP: "succeeded" means the request completed, not that the
      // section passed validation — job.result is verbatim the same body
      // /__add-section always returned (passed/sectionId/failureReport),
      // read exactly as before.
      const outcome = job.result as {
        passed?: boolean;
        sectionId?: string;
        failureReport?: string;
        error?: string;
      };
      if (outcome.error !== undefined) throw new Error(outcome.error);
      if (outcome.passed !== true || outcome.sectionId === undefined) {
        setAddSection({
          phase: "failed",
          route,
          report: outcome.failureReport ?? "unknown failure",
        });
        return;
      }
      // The new section is APPENDED to the page's source (ids are semantic, not
      // positional — contract 5.2), so the position the user clicked is
      // expressed as a sectionOrder override, exactly as a reorder is.
      const fresh = await refreshManifest();
      const sections = renderedSections(geometryByRoute[route] ?? {}, fresh, route);
      const withNew = sections.includes(outcome.sectionId)
        ? sections
        : [...sections, outcome.sectionId];
      setHistory((h) =>
        h === null
          ? h
          : pushHistory(
              h,
              placeSectionAfter(
                currentSnapshot(h),
                route,
                withNew,
                outcome.sectionId!,
                afterSection,
              ),
            ),
      );
      setRevertSection(route);
      setAddSection(null);
      setSelectedId(outcome.sectionId);
      reloadPreview(route);
    } catch (error) {
      setAddSection({ phase: "failed", route, report: String(error) });
    }
  }

  /** One handler for both scopes (PRD section 4: page regen "reuses the same
   *  flow at page granularity"). Only the endpoint and the request key differ;
   *  the response shape, the orphan handling and revert are identical, and for
   *  page scope `section` holds the route slug. */
  async function confirmRegen() {
    if (regen.phase !== "prompt") return;
    const { section, instruction, scope } = regen;
    regenStartedAtRef.current = Date.now();
    setJobNotice(undefined);
    setRegen({ phase: "running", section, scope });
    setRegenElapsedMs(0);
    try {
      const job = await enqueueAndPoll(
        `${PREVIEW_URL}${scope === "page" ? "/__regen-page" : "/__regen"}`,
        scope === "page" ? { route: section, instruction } : { section, instruction },
        { onStatus: (update) => setRegenElapsedMs((ms) => Math.max(ms, update.elapsedMs)) },
      );
      if (job.status === "interrupted") {
        setJobNotice(JOB_INTERRUPTED_MESSAGE);
        setRegen({ phase: "idle" });
        return;
      }
      if (job.status === "failed") throw new Error(job.error ?? "unknown failure");
      // THE TRAP: "succeeded" means the request completed, not that the
      // regen passed validation — job.result is verbatim the same body
      // /__regen(-page) always returned (passed/orphanedOverrides/
      // failureReport), read exactly as before.
      const outcome = job.result as {
        passed?: boolean;
        orphanedOverrides?: string[];
        failureReport?: string;
        error?: string;
      };
      if (outcome.error !== undefined) throw new Error(outcome.error);
      await refreshManifest();
      if (outcome.passed !== true) {
        setRegen({
          phase: "failed",
          section,
          scope,
          report: outcome.failureReport ?? "unknown failure",
          instruction,
        });
        return;
      }
      setRevertSection(section);
      setOrphans(outcome.orphanedOverrides ?? []);
      setRegen({ phase: "idle" });
      reloadPreview(section);
    } catch (error) {
      setRegen({ phase: "failed", section, scope, report: String(error), instruction });
    }
  }

  async function revertRegen() {
    if (revertSection === undefined) return;
    await fetch(`${PREVIEW_URL}/__regen-revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: revertSection }),
    });
    await refreshManifest();
    const section = revertSection;
    setRevertSection(undefined);
    setOrphans([]);
    reloadPreview(section);
  }

  function discardOrphan(nodeId: string) {
    setHistory((h) => (h === null ? h : pushHistory(h, removeNodeOverrides(currentSnapshot(h), nodeId))));
    setOrphans((current) => current.filter((id) => id !== nodeId));
  }

  function copyOrphan(nodeId: string) {
    const value = JSON.stringify(map[nodeId] ?? {}, null, 2);
    void navigator.clipboard?.writeText(value).catch(() => undefined);
  }

  function editPlanBrief(routeSlug: string, sectionSlug: string, brief: string) {
    void fetch(`${PREVIEW_URL}/__plan/section-brief`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeSlug, sectionSlug, brief }),
    });
  }

  /** Image replace (PRD 3.5): a text override keyed to the src attribute. */
  function commitImageSrc(src: string) {
    if (selectedId === undefined) return;
    setHistory((h) => (h === null ? h : pushHistory(h, applyTextValue(currentSnapshot(h), selectedId, src, "src"))));
  }

  async function approvePlan() {
    await fetch(`${PREVIEW_URL}/__plan/approve`, { method: "POST" });
    setPendingPlan(null);
  }

  /** Export (PRD 5). Flushes pending edits first: the debounced save could
   * otherwise still be in flight, and the exporter reads overrides from
   * disk — exporting mid-debounce would silently ship the previous state. */
  async function runExport() {
    setExportOutcome(null);
    setExportState("running");
    exportStartedAtRef.current = Date.now();
    setJobNotice(undefined);
    setExportElapsedMs(0);
    try {
      if (history !== null && routes.length > 0) {
        await writeOverrides(splitOverridesByRoute(map, routes), routes, history);
        setSaveStatus("Saved");
      }
      const job = await enqueueAndPoll(
        `${PREVIEW_URL}/__export`,
        {},
        { onStatus: (update) => setExportElapsedMs((ms) => Math.max(ms, update.elapsedMs)) },
      );
      if (job.status === "interrupted") {
        setJobNotice(JOB_INTERRUPTED_MESSAGE);
        return;
      }
      if (job.status === "failed") throw new Error(job.error ?? "unknown failure");
      // THE TRAP: "succeeded" means the request completed, not that the
      // export shipped — job.result is verbatim the same body /__export
      // always returned (ok: true|false), read exactly as before.
      const result = job.result as { ok?: boolean; message?: string; error?: string } | undefined;
      if (result === undefined) {
        // Belt-and-braces (task-4 review): enqueueAndPoll's own poll-loop
        // validation should make this unreachable in practice, and the
        // ternary below is itself evaluated inside this function's own
        // try/catch (unlike the original bug, which crashed inside
        // ExportPanel's render — outside any try/catch this function
        // controls) — so even without this guard, a `result === undefined`
        // no longer reaches the DOM as a raw TypeError. This guard exists
        // for the clear, specific diagnostic message rather than to be the
        // only thing standing between this and a crash.
        throw new Error("job succeeded but returned no result");
      }
      // A hosted-server refusal answered BEFORE a job was ever created
      // (e.g. a session expiring between opening the editor and clicking
      // Export) reaches here as `{error: "..."}` with no `ok` field —
      // enqueueAndPoll's non-202 branch hands back exactly that body, since
      // it has no way to know this endpoint's outcome is export-shaped.
      // Mapped into a real ExportFailure rather than rendering a blank
      // "Export failed" with no message.
      setExportOutcome(
        result.ok === undefined && typeof result.error === "string"
          ? { ok: false, message: result.error }
          : (result as ExportOutcome),
      );
    } catch (error) {
      setExportOutcome({ ok: false, message: `Export request failed: ${String(error)}` });
    } finally {
      setExportState("idle");
    }
  }

  const crumbs = manifest === null ? [] : breadcrumbFor(selectedId, manifest);
  const selectedNode = selectedId !== undefined ? manifest?.nodes[selectedId] : undefined;
  const selectedGeom = selectedId !== undefined ? geometry[selectedId] : undefined;
  const layoutEditable = selectedNode?.editable.includes("layout") ?? false;
  const editingGeom = editingId !== undefined ? geometry[editingId] : undefined;
  const editingMultiline = editingId !== undefined && manifest?.nodes[editingId]?.element === "Text";
  const sectionSelected =
    selectedId !== undefined && selectedId.split(".").length === 2 ? selectedId : undefined;
  /** The order the reorder control acts on — only meaningful with a section
   *  selected on a route that has more than one section to swap it with. */
  const selectedSectionOrder = ((): string[] | undefined => {
    if (sectionSelected === undefined || manifest === null) return undefined;
    const route = sectionSelected.split(".")[0]!;
    const rendered = renderedSections(geometryByRoute[route] ?? {}, manifest, route);
    if (rendered.length < 2) return undefined;
    const order = sectionOrderOf(map, route, rendered);
    return order.includes(sectionSelected) ? order : undefined;
  })();

  /** Where to draw the in-place progress overlay (PRD 4.2).
   *
   *  A section regen sits on that section's own box. A page regen has no node
   *  to sit on — its target is a route slug — so it covers the union of the
   *  route's section boxes, which is the page area being replaced. Without
   *  this a page regen would show no in-canvas progress at all, and the only
   *  feedback for a multi-minute operation would be the side panel. */
  const regenGeom = ((): NodeGeometry | undefined => {
    if (regen.phase !== "running") return undefined;
    if (regen.scope === "section") return geometry[regen.section];
    const boxes = renderedSections(geometryByRoute[regen.section] ?? {}, manifest!, regen.section)
      .map((nodeId) => geometry[nodeId])
      .filter((entry): entry is NodeGeometry => entry !== undefined);
    if (boxes.length === 0) return undefined;
    const top = Math.min(...boxes.map((box) => box.rect.y));
    const bottom = Math.max(...boxes.map((box) => box.rect.y + box.rect.height));
    const left = Math.min(...boxes.map((box) => box.rect.x));
    const right = Math.max(...boxes.map((box) => box.rect.x + box.rect.width));
    return { ...boxes[0]!, rect: { x: left, y: top, width: right - left, height: bottom - top } };
  })();
  const hoverGeom = hoverId !== undefined && hoverId !== selectedId ? geometry[hoverId] : undefined;
  const selectedStyle =
    selectedId !== undefined
      ? ((map[selectedId]?.style as Record<string, string> | undefined) ?? {})
      : {};
  const selectedHidden = selectedId !== undefined && map[selectedId]?.visibility === true;
  const anyVersionMismatch = Object.values(frameStatus).some((status) => status === "version-mismatch");
  const frameWidth = PREVIEW_WIDTHS[previewWidth];
  // Narrow widths are read-only (PRD 7 P1): an override carries no
  // breakpoint, so an edit made at 390px would silently apply everywhere.
  const widthEditable = isEditableWidth(previewWidth);

  if (pendingPlan !== null) {
    return (
      <div className="editor-root">
        <PlanApproval
          brief={pendingPlan.brief}
          routes={pendingPlan.routes}
          onEditBrief={editPlanBrief}
          onApprove={() => void approvePlan()}
        />
      </div>
    );
  }

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
          <div className="mode-toggle" data-testid="width-toggle" role="group" aria-label="Preview width">
            {(Object.keys(PREVIEW_WIDTHS) as PreviewWidth[]).map((width) => (
              <button
                key={width}
                type="button"
                data-testid={`width-${width}`}
                className={previewWidth === width ? "mode-btn active" : "mode-btn"}
                aria-pressed={previewWidth === width}
                onClick={() => setPreviewWidth(width)}
              >
                {width === "desktop" ? "Desktop" : width === "tablet" ? "Tablet" : "Mobile"}
              </button>
            ))}
          </div>
          <div className="mode-toggle" data-testid="mode-toggle" role="group" aria-label="Preview mode">
            <button
              type="button"
              data-testid="mode-edit"
              className={previewMode === "edit" ? "mode-btn active" : "mode-btn"}
              aria-pressed={previewMode === "edit"}
              onClick={() => setPreviewMode("edit")}
            >
              Edit
            </button>
            <button
              type="button"
              data-testid="mode-interact"
              className={previewMode === "interact" ? "mode-btn active" : "mode-btn"}
              aria-pressed={previewMode === "interact"}
              onClick={() => setPreviewMode("interact")}
            >
              Interact
            </button>
          </div>
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
          {revertSection !== undefined && (
            <button type="button" data-testid="revert-regen-button" onClick={() => void revertRegen()}>
              Revert regeneration
            </button>
          )}
          <button
            type="button"
            data-testid="export-button"
            className="export-button"
            disabled={exportState === "running"}
            onClick={() => void runExport()}
          >
            {exportState === "running" ? `Exporting… ${formatElapsedSeconds(exportElapsedMs)}` : "Export"}
          </button>
          <span data-testid="save-status" className="save-status">
            {saveStatus}
          </span>
        </div>
        {!widthEditable && (
          <span data-testid="readonly-banner" className="version-warning">
            Read-only at this width — overrides carry no breakpoint, so edits apply at every width.
          </span>
        )}
        {anyVersionMismatch && (
          <span data-testid="version-warning" className="version-warning">
            Preview shim protocol mismatch — rebuild the preview.
          </span>
        )}
      </header>

      <div className="editor-main">
        <div
          ref={stageRef}
          className="stage"
          data-testid="canvas-stage"
          onMouseLeave={() => setHoverId(undefined)}
          onWheel={onStageWheel}
          onPointerDown={onStagePointerDown}
        >
          <div
            className="canvas-surface"
            data-testid="canvas-surface"
            style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
          >
            {routes.map((route, index) => {
              const offsetX = frameOffsetX(index, frameWidth);
              const near = isFrameNearViewport(offsetX, frameWidth, viewport, stageSize.width);
              return (
                <div
                  key={route.slug}
                  className="frame-wrap"
                  data-testid={`frame-${route.slug}`}
                  style={{ left: offsetX, width: frameWidth, height: FRAME_HEIGHT }}
                >
                  <span className="frame-label">{route.path === "/" ? route.slug : route.path}</span>
                  {near ? (
                    <iframe
                      ref={(el) => {
                        iframeRefs.current[route.slug] = el;
                      }}
                      title={`preview-${route.slug}`}
                      data-route-slug={route.slug}
                      src={`${PREVIEW_URL}${route.path}`}
                      className="preview-frame"
                      style={{ height: FRAME_HEIGHT }}
                    />
                  ) : (
                    <div className="frame-placeholder" style={{ height: FRAME_HEIGHT }}>
                      {route.slug}
                    </div>
                  )}
                  <div className="overlay">
                    {/* PRD 4.1: "+" BETWEEN sections. One strip above the
                        first section and one below each, so every insertion
                        point on the page is reachable — including the top,
                        which a "+" only ever placed after a section could not
                        express. Positioned from live geometry, so the strips
                        follow the sections when a reorder moves them. */}
                    {addSectionSlots(route.slug).map((slot) => (
                      <button
                        type="button"
                        key={slot.afterSection ?? "top"}
                        data-testid={`add-section-slot-${slot.afterSection ?? "top"}`}
                        className="add-section-slot"
                        style={{ top: slot.y }}
                        title="Add a section here"
                        onClick={(event) => {
                          event.stopPropagation();
                          openAddSection(route.slug, slot.afterSection);
                        }}
                      >
                        <span>+</span>
                      </button>
                    ))}
                    {hoverGeom !== undefined && hoverId !== undefined && routeOf(hoverId) === route.slug && (
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
                    {regenGeom !== undefined && regen.phase === "running" && routeOf(regen.section) === route.slug && (
                      <div
                        data-testid="regen-progress"
                        className="regen-progress"
                        style={{
                          left: regenGeom.rect.x,
                          top: regenGeom.rect.y,
                          width: regenGeom.rect.width,
                          height: regenGeom.rect.height,
                        }}
                      >
                        {/* A job is opaque until it finishes (design doc's
                            "Accepted losses") -- elapsed time, not a
                            fabricated percentage, is what stays honest. */}
                        <span>Running… {formatElapsedSeconds(regenElapsedMs)}</span>
                      </div>
                    )}
                    {selectedGeom !== undefined && selectedId !== undefined && routeOf(selectedId) === route.slug && (
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
                          {/* A dedicated handle, not the whole outline body: the
                              body must stay click-through so selecting a CHILD
                              inside an already-selected parent's bounding box
                              still reaches the iframe underneath. */}
                          {layoutEditable && (
                            <span
                              data-testid="move-handle"
                              className="move-handle"
                              title="Drag to reposition"
                              onPointerDown={(event) => startLayoutDrag(event, selectedId, "move")}
                            />
                          )}
                          {layoutEditable &&
                            HANDLES.map((handle) => (
                              <span
                                key={handle}
                                data-testid={`handle-${handle}`}
                                className={`handle handle-${handle}`}
                                onPointerDown={(event) => startLayoutDrag(event, selectedId, "resize", handle)}
                              />
                            ))}
                        </div>
                      </>
                    )}
                    {dragGhost !== null && selectedId !== undefined && routeOf(selectedId) === route.slug && (
                      <div
                        data-testid="drag-ghost"
                        className={dragGhost.rejected ? "drag-ghost rejected" : "drag-ghost"}
                        style={{
                          left: dragGhost.rect.x,
                          top: dragGhost.rect.y,
                          width: dragGhost.rect.width,
                          height: dragGhost.rect.height,
                        }}
                      />
                    )}
                    {editingGeom !== undefined && editingId !== undefined && routeOf(editingId) === route.slug && (
                      <div
                        ref={editOverlayRef}
                        data-testid="text-edit-overlay"
                        className="text-edit-overlay"
                        contentEditable
                        suppressContentEditableWarning
                        style={{
                          left: editingGeom.rect.x,
                          top: editingGeom.rect.y,
                          width: editingGeom.rect.width,
                          height: editingGeom.rect.height,
                          fontFamily: editingGeom.textStyle.fontFamily,
                          fontSize: editingGeom.textStyle.fontSize,
                          fontWeight: editingGeom.textStyle.fontWeight,
                          lineHeight: editingGeom.textStyle.lineHeight,
                          color: editingGeom.textStyle.color,
                          textAlign: editingGeom.textStyle.textAlign as "left" | "right" | "center",
                        }}
                        onInput={(event) => setEditingDraft(event.currentTarget.textContent ?? "")}
                        onBlur={commitTextEdit}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelTextEdit();
                          } else if (event.key === "Enter" && (!editingMultiline || event.shiftKey)) {
                            // single-line elements: Enter always commits. Multi-line
                            // elements: only Shift+Enter commits, plain Enter inserts
                            // a newline (PRD 3.1's "multi-line allowed" case).
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="inspector" data-testid="inspector">
          {addSection !== null && (
            <AddSectionPanel
              state={addSection}
              archetypes={archetypes}
              onPick={(archetype) =>
                setAddSection((current) =>
                  current?.phase === "picking" ? { ...current, archetype } : current,
                )
              }
              onEdit={(instruction) =>
                setAddSection((current) =>
                  current?.phase === "picking" ? { ...current, instruction } : current,
                )
              }
              onConfirm={() => void confirmAddSection()}
              onCancel={() => setAddSection(null)}
            />
          )}
          <EditPrompt
            state={editPrompt}
            value={editDraft}
            onChange={setEditDraft}
            onSubmit={() => void submitEditPrompt()}
            onUndo={() => {
              setHistory((h) => (h === null ? h : undo(h)));
              setEditPrompt({ phase: "idle" });
            }}
          />
          <RegenControls
            regen={regen}
            sectionSelected={sectionSelected}
            pageSectionCount={
              sectionSelected === undefined || manifest === null
                ? 0
                : renderedSections(
                    geometryByRoute[routeOf(sectionSelected)] ?? {},
                    manifest,
                    routeOf(sectionSelected),
                  ).length
            }
            onOpen={(target, scope) =>
              setRegen({ phase: "prompt", section: target, scope, instruction: CANNED_SECTION_BRIEF })
            }
            onEdit={(instruction) =>
              setRegen((current) =>
                current.phase === "prompt" ? { ...current, instruction } : current,
              )
            }
            onConfirm={() => void confirmRegen()}
            onCancel={() => setRegen({ phase: "idle" })}
            onTryAgain={() =>
              setRegen((current) =>
                current.phase === "failed"
                  ? {
                      phase: "prompt",
                      section: current.section,
                      scope: current.scope,
                      instruction: current.instruction,
                    }
                  : current,
              )
            }
          />
          {selectedNode !== undefined && selectedId !== undefined && tokens !== null ? (
            <Inspector
              nodeId={selectedId}
              node={selectedNode}
              tokens={tokens}
              tokenPaths={tokenPathSet(tokens)}
              styleValue={selectedStyle}
              onCommit={commitStyle}
              hidden={selectedHidden}
              imageSrc={
                isKeyedTextValue(map[selectedId]?.text)
                  ? (map[selectedId]!.text as { key: string; value: string }).value
                  : undefined
              }
              onCommitImageSrc={commitImageSrc}
              onToggleVisibility={toggleVisibility}
              reorder={
                selectedSectionOrder === undefined
                  ? undefined
                  : {
                      position: selectedSectionOrder.indexOf(selectedId),
                      total: selectedSectionOrder.length,
                      onMove: (direction) => commitSectionMove(selectedId, direction),
                    }
              }
            />
          ) : (
            <p className="inspector-empty">Click an element in the preview to select it.</p>
          )}
        </aside>
      </div>

      <OrphanDialog
        orphans={orphans}
        overrides={map}
        onDiscard={discardOrphan}
        onCopy={copyOrphan}
      />

      {exportOutcome !== null && (
        <ExportPanel
          outcome={exportOutcome}
          downloadUrl={`${PREVIEW_URL}/__export-download`}
          onClose={() => setExportOutcome(null)}
          onRetry={() => void runExport()}
        />
      )}

      {gestureToast !== undefined && (
        <div data-testid="gesture-toast" className="gesture-toast">
          {gestureToast}
        </div>
      )}

      {/* A job coming back `interrupted` (server restarted mid-run) is not
          a failure -- shared by all five job-backed flows rather than
          reusing any one flow's own "failed" phase, whose language ("...
          failed") would be untrue here (JOB_INTERRUPTED_MESSAGE). Its own
          class, not `gesture-toast` (task-4 review): that class is styled
          as a transient, self-clearing toast at the bottom of the stage,
          while this banner is persistent and dismiss-only -- reusing it put
          the two directly on top of each other whenever both were active. */}
      {jobNotice !== undefined && (
        <div data-testid="job-interrupted-banner" className="job-interrupted-banner">
          <span>{jobNotice}</span>
          <button type="button" data-testid="job-interrupted-dismiss" onClick={() => setJobNotice(undefined)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
