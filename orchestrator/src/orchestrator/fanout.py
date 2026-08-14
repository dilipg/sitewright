"""Page fan-out orchestrator (build prompt 5.3, pipeline 2.5): one worker
subprocess per route, running truly in parallel — real OS processes, so a
crash in one cannot touch another and "kill -9 a page worker" is literal.
Must run AFTER the Design System and Shell agents have built the shared
workspace (everything downstream reads their output read-only) and after
the workspace has been scaffolded with an empty pages/<slug>/ + overrides
file for every planned route (prepare_workspace_dir(routes=...)).

After all workers finish, runs ONE project-level gate 6 check with the
REAL write log (which files each page/shell agent actually wrote) — the
dynamic ownership-boundary check contract 8.6 describes, not just the
static cross-page-import scan.

Usage: uv run python -m orchestrator.fanout --run-id X
"""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

from orchestrator import portable
from orchestrator.section_pipeline import (
    GENERATED_DIR,
    REPAIR_WARNING_PREFIX,
    REPO_ROOT,
    _run_compiler_cli,
    ensure_route_page_dirs,
)


def repair_warnings(stdout: str) -> list[str]:
    """The deterministic-repair lines in a page worker's stdout.

    Scanned from the FULL stream, not from `stdout_tail`: the tail is the last
    1500 characters of a stream dense with Kitaru checkpoint chatter, and a
    warning printed early in a long page is simply not in it. That truncation is
    the same one that destroyed the signal a failed generation's report needed.

    This exists because a page worker is a SUBPROCESS. Its stdout was captured,
    tailed into `workers[slug]["stdout_tail"]`, and then read by nothing at all:
    `main()` strips `workers` before printing, and `acceptance.py` keeps only
    FAILED workers' `stderr_tail`. So on a successful generation — the only run
    where the repair matters, because a failed one is loud anyway — the warning
    reached no log, no run report, no `job.error` and no UI. Re-emitting it in the
    PARENT is what fixes that: the parent's stdout is what the job result carries.
    """
    return [
        line.strip()
        for line in stdout.splitlines()
        if line.strip().startswith(REPAIR_WARNING_PREFIX)
    ]


def spawn_worker(run_id: str, route_slug: str) -> subprocess.Popen:
    # NO shell. `shell=True` here was silently Windows-only in the other
    # direction from the `cmd /c` sites: on POSIX, Popen(list, shell=True)
    # hands `sh -c` ONLY argv[0] and turns the rest into the shell's own
    # positional parameters, so this ran a bare `uv`, printed its help, exited
    # non-zero -- and every page worker "crashed" with nothing in its log.
    return portable.spawn(
        ["uv", "run", "python", "-m", "orchestrator.page_worker", "--run-id", run_id, "--route-slug", route_slug],
        cwd=REPO_ROOT / "orchestrator",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def max_parallel_workers() -> int:
    """How many page workers may run at once. **Defaults to 1 — serial.**

    THE DEFAULT CHANGED, and it changed because parallel fan-out CORRUPTS A RUN.
    Measured in a dogfood run: two workers started 424 ms apart, and Kitaru's own
    metadata store is SQLite at `journal_mode=delete` (a rollback journal, so
    writers block one another) with `busy_timeout=5000` — verified directly on
    `~/AppData/Roaming/kitaru/local_stores/default_zen_store/zenml.db`. The
    earlier worker completed `generate_section` and `write_section_only`, then
    **never got a `commit_section_manifest` row at all**: a SQLAlchemy
    `OperationalError` whose own failure-record write hit the same lock.

    The result is the worst shape available here — `ContactHero.tsx` on disk with
    no `manifest.json` entry, which is exactly what gate 4 rejects. The site
    LOOKS finished in the canvas and **can never be exported**, and no retry of
    the export can fix it because the loss already happened.

    So this is correctness over speed, deliberately: serial fan-out makes the
    fan-out phase roughly N× longer for N routes (it was 325 s of a 545 s
    2-route run), and `docs/reports/m7-wall-clock.md`'s parallel figures no
    longer describe the default. A slower run is visible and survivable; a
    silently unexportable project is neither.

    Raising this is allowed and is how the old behaviour comes back — but it
    reopens the race until Kitaru's store is WAL, which is the recorded
    follow-up (`docs/pending.md`, K1).

    Refuses a bad value rather than clamping, the same call `loadMasterKey` and
    `shutdown-budget.ts` already make: a silently-ignored limit produces a
    concurrency nobody chose, and its failure surfaces minutes later as workers
    dying with no output.
    """
    raw = os.environ.get("WEBGEN_FANOUT_MAX_WORKERS", "").strip()
    if raw == "":
        return 1
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"WEBGEN_FANOUT_MAX_WORKERS must be a positive integer; got {raw!r}") from exc
    if value < 1:
        raise ValueError(f"WEBGEN_FANOUT_MAX_WORKERS must be at least 1; got {value}")
    return value


def collect_written_files(project_dir: Path, route_slug: str) -> list[str]:
    page_dir = project_dir / "src" / "pages" / route_slug
    if not page_dir.exists():
        return []
    return sorted(
        str(path.relative_to(project_dir)).replace("\\", "/")
        for path in page_dir.rglob("*")
        if path.is_file()
    )


def run_fanout(run_id: str) -> dict:
    project_dir = GENERATED_DIR / run_id
    plan = json.loads((project_dir / "plan" / "siteplan.json").read_text(encoding="utf-8"))
    route_slugs = [r["slug"] for r in plan["routes"]]

    # scaffold every route beyond "home" (the DS agent's initial workspace
    # prep only ever creates that one) WITHOUT resetting the DS/Shell
    # agents' already-written tokens/primitives/shell
    ensure_route_page_dirs(
        str(project_dir), routes=[{"slug": r["slug"], "path": r["path"]} for r in plan["routes"]]
    )

    max_parallel = max_parallel_workers()
    print(
        f"=== fan-out: {len(route_slugs)} page workers, at most {max_parallel} at a time: {route_slugs}",
        flush=True,
    )
    started_at: dict[str, float] = {}
    workers: dict[str, dict] = {}
    # Batched rather than all-at-once. Every route used to be spawned
    # simultaneously with no cap: fine on a developer machine, fatal in a small
    # container. Measured in Docker (3.8 GB VM, 4 routes): two of the four
    # workers were killed with EMPTY stdout AND stderr, surfacing only as
    # `manifest CLI produced no result` — which reads like a compiler bug rather
    # than the memory exhaustion it was. The DEFAULT is unchanged behaviour (all
    # at once), so no existing invocation and none of the measured wall-clock
    # profile moves; a container sets a small value.
    for batch_start in range(0, len(route_slugs), max_parallel):
        procs: dict[str, subprocess.Popen] = {}
        for slug in route_slugs[batch_start : batch_start + max_parallel]:
            started_at[slug] = time.monotonic()
            procs[slug] = spawn_worker(run_id, slug)
        for slug, proc in procs.items():
            stdout, stderr = proc.communicate()
            warnings = repair_warnings(stdout)
            workers[slug] = {
                "returncode": proc.returncode,
                "started_at": round(started_at[slug], 3),
                "duration_s": round(time.monotonic() - started_at[slug], 2),
                "stdout_tail": stdout[-1500:],
                "stderr_tail": stderr[-1500:],
                "repair_warnings": warnings,
            }
            print(f"=== {slug}: exit={proc.returncode} duration={workers[slug]['duration_s']}s", flush=True)
            for warning in warnings:
                print(f"=== {slug}: {warning}", flush=True)

    written_files = {f"page:{slug}": collect_written_files(project_dir, slug) for slug in route_slugs}
    written_files["shell"] = sorted(
        f"src/shell/{name}"
        for name in ("AppShell.tsx", "Nav.tsx", "Footer.tsx", "routes.ts")
        if (project_dir / "src" / "shell" / name).exists()
    )
    ownership_map = {
        owner: [f"src/pages/{owner.split(':')[1]}/"] for owner in written_files if owner.startswith("page:")
    }
    ownership_map["shell"] = ["src/shell/"]

    write_log_file = project_dir / ".fanout-write-log.json"
    ownership_file = project_dir / ".fanout-ownership.json"
    write_log_file.write_text(json.dumps(written_files), encoding="utf-8")
    ownership_file.write_text(json.dumps(ownership_map), encoding="utf-8")
    gates_result = _run_compiler_cli(
        [
            "scripts/gates.ts",
            str(project_dir),
            "--json",
            # Unscoped by design (the whole-project check) and unscoped
            # typecheck with it: every worker has finished, so nothing is
            # in flight and a type error anywhere is genuinely the run's.
            "--typecheck",
            "--write-log",
            str(write_log_file),
            "--ownership-map",
            str(ownership_file),
        ]
    )
    write_log_file.unlink(missing_ok=True)
    ownership_file.unlink(missing_ok=True)
    gate_report = json.loads(gates_result.stdout)

    all_ok = all(w["returncode"] == 0 for w in workers.values()) and gate_report["passed"]
    return {
        "run_id": run_id,
        "routes": route_slugs,
        "workers": workers,
        # OUTSIDE `workers` deliberately: main() prints the result with `workers`
        # stripped, and acceptance.py reads only failed workers' stderr. A signal
        # nested inside `workers` is a signal nothing reads (see repair_warnings).
        "repair_warnings": [
            f"{slug}: {warning}"
            for slug, worker in workers.items()
            for warning in worker["repair_warnings"]
        ],
        "gate_report": gate_report,
        "passed": all_ok,
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.fanout")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    result = run_fanout(args.run_id)
    print(json.dumps({k: v for k, v in result.items() if k != "workers"}, indent=2, default=str))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
