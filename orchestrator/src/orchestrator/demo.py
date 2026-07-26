"""Single-step demo pipeline (build prompt 3.1): canned prompt → checkpointed
model call → checkpointed file write. --crash hard-kills the process after
the model call (simulating an OOM/kill -9 worker); `resume` replays the run,
and the completed model call returns its recorded result without a new API
call — proven by the token-accounting log gaining no rows.

Usage:
  uv run python -m orchestrator.demo run --brief "..." --out <dir> [--crash]
  uv run python -m orchestrator.demo resume --exec-id kr-...
"""

import argparse
import json
import os

import kitaru
from kitaru import checkpoint, flow

from orchestrator.files import replace_section_files
from orchestrator.model_call import model_call

DEMO_SYSTEM = (
    "You are a marketing copywriter. Reply with exactly one short tagline "
    "sentence and nothing else."
)


@checkpoint
def write_tagline_file(out_dir: str, model_result: dict) -> list[str]:
    """Shapes model output into files INSIDE a checkpoint: flow bodies must
    pass checkpoint outputs around as handles, never peek into them — on
    replay a played-back output is a lazy artifact handle, materialized only
    when it crosses into a downstream checkpoint."""
    return replace_section_files(
        out_dir, {"tagline.txt": model_result["text"].strip() + "\n"}
    )


@flow
def demo_pipeline(brief: str, out_dir: str, crash_after_model_call: bool = False) -> list[str]:
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)

    result = model_call(
        role="page",
        system=DEMO_SYSTEM,
        user=f"Write a tagline for: {brief}",
        max_tokens=100,
    )

    if crash_after_model_call and not kitaru.is_replay():
        print("simulated crash (kill -9) after the model call", flush=True)
        os._exit(13)

    return write_tagline_file(out_dir, result)


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.demo")
    subcommands = parser.add_subparsers(dest="command", required=True)

    run_parser = subcommands.add_parser("run")
    run_parser.add_argument("--brief", required=True)
    run_parser.add_argument("--out", required=True)
    run_parser.add_argument("--crash", action="store_true")

    resume_parser = subcommands.add_parser("resume")
    resume_parser.add_argument("--exec-id", required=True)
    resume_parser.add_argument(
        "--at",
        default="call_model",
        help="earliest recorded checkpoint; it is anchored AND skipped, so its recorded result plays back and only unrecorded work re-executes",
    )

    args = parser.parse_args()
    if args.command == "run":
        handle = demo_pipeline.run(
            brief=args.brief, out_dir=args.out, crash_after_model_call=args.crash
        )
        result = handle.wait()
        print(json.dumps(result, indent=2, default=str))
    else:
        # Resume idiom (kitaru.replay.build_replay_plan): checkpoints before
        # `at` play back; `at` itself would RE-EXECUTE unless listed in `skip`,
        # which plays back its recorded result instead. Anchoring at the
        # earliest recorded checkpoint and skipping it = resume without
        # re-billing completed model calls. A single-execution replay runs
        # synchronously; the submission carries result/failure rows.
        submission = demo_pipeline.replay(args.exec_id, at=args.at, skip=[args.at])
        for row in submission.results:
            print(json.dumps(row.__dict__, indent=2, default=str))
        if submission.failures:
            for failure in submission.failures:
                print(json.dumps(failure.__dict__, indent=2, default=str))
            raise SystemExit(1)


if __name__ == "__main__":
    main()
