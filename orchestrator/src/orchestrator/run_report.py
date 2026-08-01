"""DAG run report (pipeline section 7, build prompt 6.3).

Section 7 asks for "a run timeline showing the DAG with per-node status,
cost, and drill-down to the exact rendered prompt and raw output". The run
log is a flat JSONL event stream; this module reconstructs the pipeline DAG
from it and renders a self-contained HTML report.

The DAG is implicit in the event stream rather than recorded explicitly:
event_type identifies the stage, and section ids carry their route as the
first dot-segment, so `home.hero` belongs to route `home` under fan-out.
Reconstructing it here (instead of writing extra structure into the log)
keeps the log append-only and lets old runs be re-read by newer reports.

Costs come from pricing.py — the same table `cost_for_run` uses, so a report
and a cost summary can never disagree. A model with no configured price
yields None rather than 0.0, matching run_cost's own contract.

Usage: uv run python -m orchestrator.run_report <run-id> [-o report.html]
"""

import argparse
import html
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from orchestrator.pricing import PRICING_PER_TOKEN, usage_cost
from orchestrator.runlog import default_run_log_path, read_run_events

# Pipeline order, so the report reads top-to-bottom the way the run executed
# rather than in whatever order the log happens to hold.
STAGE_ORDER = ["intake", "plan", "design", "shell", "fan-out"]

# event_type -> (stage, node label within that stage)
_EVENT_STAGES: dict[str, tuple[str, str]] = {
    "intake.complete": ("intake", "intake"),
    "plan.complete": ("plan", "planner"),
    "tokens.complete": ("design", "tokens"),
    "primitives.complete": ("design", "primitives"),
    "shell.complete": ("shell", "shell"),
}


def _safe_cost(model: str | None, usage: dict | None) -> float | None:
    """None when the model has no configured price (the gemini escape hatch),
    so a partial total is never reported as a real zero."""
    if model is None or usage is None:
        return None
    if model not in PRICING_PER_TOKEN:
        return None
    return usage_cost(model, usage)


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _exec_id(event: dict) -> str:
    """The Kitaru execution a event belongs to. Two runs of the same section
    (a re-soak, a resumed worker) share the section id but not the exec id —
    keeping them apart is what stops a stale attempt from being reported as
    part of the current one."""
    ref = event.get("checkpoint_ref") or ""
    return ref.split("/")[0] if "/" in ref else ""


def _blank_node(node_id: str, label: str) -> dict:
    return {
        "id": node_id,
        "label": label,
        "status": "unknown",
        "attempts": [],
        "cost_usd": 0.0,
        "unpriced": False,
        "tokens": 0,
        "started_at": None,
        "ended_at": None,
        "measured_s": 0.0,
    }


def _record_usage(node: dict, event: dict) -> None:
    usage = event.get("usage") or {}
    node["tokens"] += sum(
        usage.get(key, 0)
        for key in (
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        )
    )
    cost = _safe_cost(event.get("model"), event.get("usage"))
    if cost is None and event.get("usage") is not None:
        node["unpriced"] = True
    elif cost is not None:
        node["cost_usd"] += cost


def _touch_times(node: dict, event: dict) -> None:
    """Run-log timestamps are written when a call COMPLETES, so the event time
    is the node's END. When the event also carries duration_s (added in 6.3),
    the true start is derivable and the timeline bar shows real latency;
    without it (runs logged before 6.3) the bar collapses to the span between
    a section's generation and validation events, which is honest about
    ordering but understates work."""
    stamp = event.get("timestamp")
    if stamp is None:
        return
    end = _parse_time(stamp)
    duration = event.get("duration_s")
    start_stamp = stamp
    if end is not None and isinstance(duration, (int, float)):
        start_stamp = (end - timedelta(seconds=float(duration))).isoformat()
        node["measured_s"] = round(node.get("measured_s", 0.0) + float(duration), 3)

    if node["started_at"] is None or start_stamp < node["started_at"]:
        node["started_at"] = start_stamp
    if node["ended_at"] is None or stamp > node["ended_at"]:
        node["ended_at"] = stamp


def build_dag(events: list[dict]) -> dict:
    """Reconstructs the run DAG. Pure: same events in, same structure out —
    node and group ordering are deterministic (pipeline order, then id)."""
    stages: dict[str, dict] = {}

    def stage_of(name: str) -> dict:
        return stages.setdefault(name, {"name": name, "groups": {}})

    def group_of(stage_name: str, group_name: str) -> dict:
        groups = stage_of(stage_name)["groups"]
        return groups.setdefault(group_name, {"name": group_name, "nodes": {}})

    for event in events:
        event_type = event.get("event_type", "")

        if event_type in _EVENT_STAGES:
            stage_name, label = _EVENT_STAGES[event_type]
            group = group_of(stage_name, stage_name)
            node = group["nodes"].setdefault(label, _blank_node(label, label))
            node["attempts"].append(_attempt_from(event))
            _record_usage(node, event)
            _touch_times(node, event)
            # A stage event carries no gate result; reaching the log at all
            # means the call returned structured output the flow accepted.
            if node["status"] == "unknown":
                node["status"] = "passed"
            continue

        section = event.get("section")
        if section is None:
            continue
        route = section.split(".")[0]
        group = group_of("fan-out", route)
        node = group["nodes"].setdefault(section, _blank_node(section, section))
        _touch_times(node, event)

        if event_type == "section.generated":
            node["attempts"].append(_attempt_from(event))
            _record_usage(node, event)
        elif event_type == "section.validated":
            gates = event.get("gate_results") or {}
            passed = gates.get("passed") is True
            node["status"] = "passed" if passed else "failed"
            _attach_gate_result(node, event, gates)

    return {
        "stages": [_finalize_stage(stages[name]) for name in STAGE_ORDER if name in stages],
        **_run_totals(stages, events),
    }


def _attempt_from(event: dict) -> dict:
    """One model call, with everything needed to debug it: the exact rendered
    prompts and the raw output (section 7's drill-down requirement)."""
    return {
        "attempt": event.get("attempt"),
        "exec_id": _exec_id(event),
        "timestamp": event.get("timestamp"),
        "model": event.get("model"),
        "template_name": event.get("template_name"),
        "template_version": event.get("template_version"),
        "prompt_hash": event.get("prompt_hash"),
        "usage": event.get("usage") or {},
        "duration_s": event.get("duration_s"),
        "cost_usd": _safe_cost(event.get("model"), event.get("usage")),
        "system_prompt": event.get("system_prompt") or "",
        "user_prompt": event.get("user_prompt") or "",
        "raw_output": event.get("raw_output") or "",
        "gate_failures": [],
        "gates_passed": None,
    }


def _attach_gate_result(node: dict, event: dict, gates: dict) -> None:
    """Gate results arrive in their own event; fold them into the attempt they
    validated so one row shows both the call and its verdict."""
    failures = [
        f"gate {failure.get('gate', '?')} ({failure.get('reason', '')}): {failure.get('message', '')}"
        for failure in gates.get("failures", [])
    ]
    attempt_number = event.get("attempt")
    target = None
    for candidate in reversed(node["attempts"]):
        if candidate["attempt"] == attempt_number and candidate["gates_passed"] is None:
            target = candidate
            break
    if target is None:
        # A validation with no matching generation event (possible when a log
        # is truncated mid-run) still has to be visible rather than dropped.
        target = _blank_attempt(attempt_number, event)
        node["attempts"].append(target)
    target["gates_passed"] = gates.get("passed") is True
    target["gate_failures"] = failures


def _blank_attempt(attempt_number: Any, event: dict) -> dict:
    return {
        "attempt": attempt_number,
        "exec_id": _exec_id(event),
        "timestamp": event.get("timestamp"),
        "model": None,
        "template_name": None,
        "template_version": None,
        "prompt_hash": None,
        "usage": {},
        "duration_s": None,
        "cost_usd": None,
        "system_prompt": "",
        "user_prompt": "",
        "raw_output": "",
        "gate_failures": [],
        "gates_passed": None,
    }


def _finalize_stage(stage: dict) -> dict:
    groups = []
    for name in sorted(stage["groups"]):
        group = stage["groups"][name]
        nodes = [group["nodes"][node_id] for node_id in sorted(group["nodes"])]
        groups.append(
            {
                "name": name,
                "nodes": nodes,
                "status": _rollup([node["status"] for node in nodes]),
                "cost_usd": sum(node["cost_usd"] for node in nodes),
                "tokens": sum(node["tokens"] for node in nodes),
                "measured_s": round(sum(node["measured_s"] for node in nodes), 3),
            }
        )
    return {
        "name": stage["name"],
        "groups": groups,
        "status": _rollup([group["status"] for group in groups]),
        "cost_usd": sum(group["cost_usd"] for group in groups),
        "tokens": sum(group["tokens"] for group in groups),
        "measured_s": round(sum(group["measured_s"] for group in groups), 3),
    }


def _rollup(statuses: list[str]) -> str:
    """A parent is only green when every child is: one failed section makes
    its route failed, and one failed route makes the run failed. "unknown"
    (a node with no gate verdict — a crashed worker) is not success."""
    if not statuses:
        return "unknown"
    if any(status == "failed" for status in statuses):
        return "failed"
    if all(status == "passed" for status in statuses):
        return "passed"
    return "unknown"


# A run log is append-only and keyed by run_id, so a later REGENERATION of a
# section appends to the same log hours or days after the original generation.
# Spanning first-to-last event then reports the wall clock as the gap between
# them -- observed live at 44 hours for a run that generated in 291 seconds.
# Events are therefore grouped into sessions separated by a long idle gap, and
# the run's duration is its FIRST session: the original generation.
SESSION_GAP_S = 15 * 60


def _sessions(stamps: list[str]) -> list[tuple[str, str]]:
    """Contiguous (start, end) spans, split wherever the log goes quiet for
    longer than SESSION_GAP_S."""
    parsed = sorted((s for s in stamps if s), key=str)
    if not parsed:
        return []
    spans: list[tuple[str, str]] = []
    start = previous = parsed[0]
    for stamp in parsed[1:]:
        gap_from = _parse_time(previous)
        gap_to = _parse_time(stamp)
        if gap_from and gap_to and (gap_to - gap_from).total_seconds() > SESSION_GAP_S:
            spans.append((start, previous))
            start = stamp
        previous = stamp
    spans.append((start, previous))
    return spans


def _run_totals(stages: dict, events: list[dict]) -> dict:
    all_nodes = [
        node
        for stage in stages.values()
        for group in stage["groups"].values()
        for node in group["nodes"].values()
    ]
    spans = _sessions([event.get("timestamp", "") for event in events])
    started, ended = spans[0] if spans else (None, None)
    start_dt, end_dt = _parse_time(started), _parse_time(ended)
    return {
        "started_at": started,
        "ended_at": ended,
        "later_sessions": max(0, len(spans) - 1),
        "duration_s": round((end_dt - start_dt).total_seconds(), 1)
        if start_dt and end_dt
        else None,
        "measured_s": round(sum(node["measured_s"] for node in all_nodes), 3),
        "total_cost_usd": sum(node["cost_usd"] for node in all_nodes),
        "total_tokens": sum(node["tokens"] for node in all_nodes),
        "unpriced": any(node["unpriced"] for node in all_nodes),
        "status": _rollup([node["status"] for node in all_nodes]),
        "node_count": len(all_nodes),
    }


# ---------- rendering ----------


def _json_for_script(data: Any) -> str:
    """Inlines JSON into a <script> safely: prompts contain JSX, so an
    unescaped "</script>" inside one would end the block early."""
    return (
        json.dumps(data)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )


_STYLE = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #141418; color: #e8e8ee;
  font: 13px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { padding: 14px 20px; background: #26262e; border-bottom: 1px solid #333340;
  display: flex; flex-wrap: wrap; gap: 18px; align-items: baseline; }
h1 { font-size: 15px; margin: 0; }
.meta { color: #9a9aa8; font-size: 12px; }
.badge { font-weight: 600; padding: 2px 8px; border-radius: 999px; font-size: 11px; }
.badge.passed { background: #1d3a2a; color: #7fd3a0; }
.badge.failed { background: #4a2320; color: #ff9d8a; }
.badge.unknown { background: #3a3a46; color: #c8c8d4; }
main { padding: 16px 20px 48px; max-width: 1200px; }
.stage { margin-bottom: 18px; border: 1px solid #333340; border-radius: 8px; overflow: hidden; }
.stage > .row { background: #22222a; }
.row { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
  border-bottom: 1px solid #2c2c36; }
.row .name { font-weight: 600; }
.row .spacer { flex: 1; }
.row .num { color: #9a9aa8; font-size: 12px; font-variant-numeric: tabular-nums; }
.group > .row { background: #1c1c23; padding-left: 24px; }
.node > .row { padding-left: 40px; cursor: pointer; }
.node > .row:hover { background: #1e1e26; }
.node .name { font-family: ui-monospace, monospace; font-weight: 400; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.passed { background: #7fd3a0; } .dot.failed { background: #ff9d8a; }
.dot.unknown { background: #9a9aa8; }
.bar { height: 6px; border-radius: 3px; background: #4f8ef7; min-width: 2px; opacity: .75; }
.bar-track { width: 220px; flex: none; background: #22222a; border-radius: 3px; }
.detail { display: none; padding: 4px 12px 14px 40px; background: #101014;
  border-bottom: 1px solid #2c2c36; }
.detail.open { display: block; }
.attempt { border-top: 1px solid #2c2c36; padding: 10px 0; }
.attempt-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.attempt-head .num { font-variant-numeric: tabular-nums; }
.tabs { display: flex; gap: 4px; margin: 8px 0 6px; }
.tabs button { background: none; border: none; border-bottom: 2px solid transparent;
  color: #9a9aa8; font-size: 12px; padding: 4px 8px; cursor: pointer; }
.tabs button.active { color: #e8e8ee; border-bottom-color: #4f8ef7; }
pre { white-space: pre-wrap; word-break: break-word; font-size: 11px; margin: 0;
  background: #0a0a0d; padding: 10px; border-radius: 6px; max-height: 380px; overflow: auto; }
.gate-fail { color: #ff9d8a; font-size: 12px; margin: 4px 0 0; }
.empty { color: #9a9aa8; }
"""

_SCRIPT = """
const DAG = window.__DAG__;
const fmtUsd = (v) => v === null || v === undefined ? "—" : "$" + v.toFixed(4);
const fmtTokens = (v) => v.toLocaleString();

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Timeline bars are positioned against the whole run's span, so a node's bar
// shows WHEN it ran, not just how long — the point of a timeline view.
const runStart = DAG.started_at ? Date.parse(DAG.started_at) : 0;
const runSpan = DAG.ended_at ? Math.max(1, Date.parse(DAG.ended_at) - runStart) : 1;

function timelineBar(node) {
  const track = el("div", "bar-track");
  const bar = el("div", "bar");
  if (node.started_at && node.ended_at) {
    const offset = (Date.parse(node.started_at) - runStart) / runSpan * 100;
    const width = (Date.parse(node.ended_at) - Date.parse(node.started_at)) / runSpan * 100;
    bar.style.marginLeft = offset.toFixed(2) + "%";
    bar.style.width = Math.max(width, 0.6).toFixed(2) + "%";
  }
  if (node.started_at && node.ended_at) {
    track.title = node.started_at + "  ->  " + node.ended_at;
  }
  track.appendChild(bar);
  return track;
}

function row(depth, status, name, node) {
  const wrap = el("div", "row");
  wrap.appendChild(el("span", "dot " + status));
  wrap.appendChild(el("span", "name", name));
  wrap.appendChild(el("div", "spacer"));
  if (node) wrap.appendChild(timelineBar(node));
  return wrap;
}

function numbers(wrap, tokens, cost, measured) {
  // Measured latency is the sum of real model-call durations (logged from
  // 6.3 on). Absent for older runs, where it is omitted rather than shown
  // as 0s — a wrong number is worse than a missing one.
  if (measured) wrap.appendChild(el("span", "num", measured.toFixed(1) + "s"));
  wrap.appendChild(el("span", "num", fmtTokens(tokens) + " tok"));
  wrap.appendChild(el("span", "num", fmtUsd(cost)));
}

function attemptBlock(attempt) {
  const box = el("div", "attempt");
  const head = el("div", "attempt-head");
  const label = attempt.attempt === null || attempt.attempt === undefined
    ? "call" : "attempt " + attempt.attempt;
  head.appendChild(el("strong", null, label));
  if (attempt.gates_passed !== null) {
    head.appendChild(el("span", "badge " + (attempt.gates_passed ? "passed" : "failed"),
      attempt.gates_passed ? "gates passed" : "gates failed"));
  }
  if (attempt.model) head.appendChild(el("span", "num", attempt.model));
  if (attempt.template_name) {
    head.appendChild(el("span", "num",
      attempt.template_name + " v" + (attempt.template_version || "?")));
  }
  const usage = attempt.usage || {};
  head.appendChild(el("span", "num",
    "in " + (usage.input_tokens || 0) + " / out " + (usage.output_tokens || 0) +
    " / cache r" + (usage.cache_read_input_tokens || 0) +
    " w" + (usage.cache_creation_input_tokens || 0)));
  if (attempt.duration_s) head.appendChild(el("span", "num", attempt.duration_s.toFixed(1) + "s"));
  head.appendChild(el("span", "num", fmtUsd(attempt.cost_usd)));
  if (attempt.prompt_hash) head.appendChild(el("span", "num", "prompt " + attempt.prompt_hash));
  box.appendChild(head);

  for (const failure of attempt.gate_failures) {
    box.appendChild(el("p", "gate-fail", failure));
  }

  const panes = [
    ["system", attempt.system_prompt],
    ["user prompt", attempt.user_prompt],
    ["raw output", attempt.raw_output],
  ].filter(([, body]) => body);
  if (panes.length) {
    const tabs = el("div", "tabs");
    const pre = el("pre");
    panes.forEach(([name, body], index) => {
      const button = el("button", index === 0 ? "active" : null, name);
      button.onclick = () => {
        pre.textContent = body;
        for (const sibling of tabs.children) sibling.className = "";
        button.className = "active";
      };
      tabs.appendChild(button);
    });
    pre.textContent = panes[0][1];
    box.appendChild(tabs);
    box.appendChild(pre);
  }
  return box;
}

const main = document.querySelector("main");
if (!DAG.stages.length) {
  main.appendChild(el("p", "empty", "No events in this run log."));
}
for (const stage of DAG.stages) {
  const stageEl = el("div", "stage");
  const stageRow = row(0, stage.status, stage.name, null);
  numbers(stageRow, stage.tokens, stage.cost_usd, stage.measured_s);
  stageEl.appendChild(stageRow);

  for (const group of stage.groups) {
    const groupEl = el("div", "group");
    // A single-node stage (intake, shell) would show the same label twice.
    if (!(group.nodes.length === 1 && group.name === stage.name)) {
      const groupRow = row(1, group.status, group.name, null);
      numbers(groupRow, group.tokens, group.cost_usd, group.measured_s);
      groupEl.appendChild(groupRow);
    }
    for (const node of group.nodes) {
      const nodeEl = el("div", "node");
      const nodeRow = row(2, node.status, node.label, node);
      nodeRow.appendChild(el("span", "num",
        node.attempts.length + (node.attempts.length === 1 ? " call" : " calls")));
      numbers(nodeRow, node.tokens, node.cost_usd, node.measured_s);
      const detail = el("div", "detail");
      for (const attempt of node.attempts) detail.appendChild(attemptBlock(attempt));
      if (!node.attempts.length) detail.appendChild(el("p", "empty", "No model calls logged."));
      nodeRow.onclick = () => detail.classList.toggle("open");
      nodeEl.appendChild(nodeRow);
      nodeEl.appendChild(detail);
      groupEl.appendChild(nodeEl);
    }
    stageEl.appendChild(groupEl);
  }
  main.appendChild(stageEl);
}
"""


def render_html(run_id: str, dag: dict) -> str:
    unpriced_note = (
        " · some calls used a model with no configured price; cost is a partial figure"
        if dag.get("unpriced")
        else ""
    )
    duration = dag.get("duration_s")
    # Rendered only when there ARE later sessions: an empty span with an
    # explanatory tooltip is noise on the overwhelmingly common single-run log.
    later = dag.get("later_sessions") or 0
    later_sessions_note = (
        ""
        if later == 0
        else (
            '<span class="meta" title="this log also contains later sessions, e.g. '
            "regenerations; their events appear in the DAG but not in the wall-clock "
            f'figure">+{later} later session(s)</span>'
        )
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Run {html.escape(run_id)} — DAG report</title>
<style>{_STYLE}</style>
</head>
<body>
<header>
  <h1>Run {html.escape(run_id)}</h1>
  <span class="badge {dag["status"]}">{dag["status"]}</span>
  <span class="meta">{dag["node_count"]} nodes</span>
  <span class="meta" title="wall clock of the original generation session">{"—" if duration is None else f"{duration}s wall"}</span>
  {later_sessions_note}
  <span class="meta" title="sum of measured model-call latency across all nodes; blank for runs logged before 6.3">{"" if not dag.get("measured_s") else f"{dag['measured_s']:.0f}s in model calls"}</span>
  <span class="meta">{dag["total_tokens"]:,} tokens</span>
  <span class="meta">${dag["total_cost_usd"]:.4f}{html.escape(unpriced_note)}</span>
</header>
<main></main>
<script>window.__DAG__ = {_json_for_script(dag)};</script>
<script>{_SCRIPT}</script>
</body>
</html>
"""


def build_report(run_id: str) -> str:
    events = read_run_events(default_run_log_path(run_id))
    return render_html(run_id, build_dag(events))


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.run_report")
    parser.add_argument("run_id")
    parser.add_argument("-o", "--out", help="Output HTML path (default: <run-id>-report.html)")
    args = parser.parse_args()

    log_path = default_run_log_path(args.run_id)
    if not log_path.exists():
        raise SystemExit(f"no run log at {log_path}")

    out_path = Path(args.out) if args.out else log_path.with_name(f"{args.run_id}-report.html")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(build_report(args.run_id), encoding="utf-8")
    print(f"Report -> {out_path}")


if __name__ == "__main__":
    main()
