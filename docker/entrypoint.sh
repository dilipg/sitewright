#!/bin/sh
# docker/entrypoint.sh — shared by both compose services.
#
# WHAT THIS FILE MUST NEVER DO, stated first because it is the one mistake that
# destroys a tester's data silently:
#
#   IT NEVER GENERATES WEBGEN_MASTER_KEY.
#
# Every stored API key is AES-256-GCM ciphertext under that key. A convenient
# `WEBGEN_MASTER_KEY=${WEBGEN_MASTER_KEY:-$(openssl rand -base64 32)}` here would
# make the stack start beautifully every time and make every previously saved API
# key permanently undecryptable on the second `docker compose up` — with no error
# at boot, because the key is only used later, when something tries to decrypt.
# The correct behaviour for a missing key is to REFUSE TO START and say where the
# key is supposed to come from.
#
# `server/src/master-key.ts` already refuses, with a good message. This adds a
# check in front of it for one reason the app cannot cover: compose reads the key
# from `.env.docker` with `required: false`, so a MISSING FILE is silent, and
# `loadMasterKey`'s message ("generate one with…") is exactly the wrong instinct
# on a restart. The message below distinguishes first run from restart.

set -eu

ROLE="${1:-}"

DB_PATH=/app/server/data/identity.db
PROJECTS_ROOT=/app/generated

# `printf '%s\n'`, never `echo`. This image's /bin/sh is dash, whose `echo`
# interprets backslash escapes in its ARGUMENT — so the literal `\n` inside the
# `printf 'WEBGEN_MASTER_KEY=%s\n' …` command this function prints as ADVICE was
# being expanded, and the instruction reached the operator split across two lines
# and uncopyable. Caught by actually running the refusal rather than reading it.
# `printf '%s\n' "$*"` passes the text through untouched.
die() {
  # >&2 so it lands in `docker compose logs` as an error, not as chatter.
  printf '\n%s\n\n' "$*" >&2
  exit 1
}

require_master_key() {
  if [ -n "${WEBGEN_MASTER_KEY:-}" ]; then
    return 0
  fi
  die "WEBGEN_MASTER_KEY is not set, so the server will not start.

It is read from an env file next to compose.yaml called .env.docker, which is
gitignored and which you create ONCE:

  printf 'WEBGEN_MASTER_KEY=%s\n' \"\$(openssl rand -base64 32)\" > .env.docker

  (Windows PowerShell, if you have no openssl:
     \$b = [byte[]]::new(32)
     [System.Security.Cryptography.RandomNumberGenerator]::Fill(\$b)
     \"WEBGEN_MASTER_KEY=\$([Convert]::ToBase64String(\$b))\" | Set-Content -NoNewline .env.docker)

GENERATE IT ONCE AND KEEP IT. Every API key you save is encrypted under this
key. If you are seeing this on a RESTART, do NOT generate a new one: put the
original value back. A different key does not fail at boot — it fails later,
when the server tries to decrypt your stored API key, and there is no way to
recover the old ciphertext.

It must be canonical padded base64, not hex. A 64-character hex string PASSES
the base64 check and fails only on length, reporting 'got 48' — which reads
like a wrong key but means a wrong encoding."
}

prepare_paths() {
  # Both are bind-mounted from the host repo (compose.yaml). Creating them here
  # rather than relying on the mount means a tester who deleted `generated/`
  # still gets a working boot instead of an adoption warning.
  mkdir -p "$(dirname "$DB_PATH")" "$PROJECTS_ROOT"

  # `code-version.ts` runs `git rev-parse HEAD` at boot. Over a bind mount the
  # checkout's ownership does not match this container's user, and git refuses
  # with "detected dubious ownership" — which is caught and swallowed, silently
  # degrading the code version to the "unknown" sentinel and making every job
  # resume refuse with 409. `|| true` because a run WITHOUT the bind mount has
  # no repo at all, and that is a legitimate (documented) degradation, not a
  # reason to fail the boot.
  git config --global --add safe.directory /app || true
}

case "$ROLE" in
  server)
    shift
    require_master_key
    prepare_paths
    cd /app/server

    # --projects-root is passed EXPLICITLY and absolutely. `job-worker.ts`'s
    # `assertProjectsRootMatchesOrchestrator` refuses to construct the worker —
    # and so refuses to boot this process — unless this resolves to the same
    # directory `orchestrator.acceptance` writes into, which is the sibling
    # `generated/` of the orchestrator package: /app/generated. If you ever see
    # that refusal, it is the guard doing its job, not a bug; the alternative it
    # prevents is a ~$1.74 generation landing where nothing looks for it and
    # still reporting success.
    #
    # --db is absolute for the reason the README already documents at length:
    # both this script and scripts/user.ts resolve --db against CWD, and two
    # different working directories silently produce two different databases
    # whose only symptom is the deliberately uniform "invalid email or
    # password".
    set -- \
      --db "$DB_PATH" \
      --projects-root "$PROJECTS_ROOT" \
      --port "${WEBGEN_PORT:-4000}" \
      "$@"

    # Optional, and only useful on a machine that already has generated sites in
    # `generated/` from the from-source path: adopts them for this account so
    # they show up in the picker. Never creates the user — an unresolved address
    # is a skip, by design (no HTTP route and no startup path may create a user;
    # only scripts/user.ts may).
    if [ -n "${WEBGEN_BOOTSTRAP_EMAIL:-}" ]; then
      set -- "$@" --bootstrap-email "$WEBGEN_BOOTSTRAP_EMAIL"
    fi

    exec node scripts/serve.ts "$@"
    ;;

  editor)
    shift
    # No master key needed, and deliberately not required: this process is a
    # Vite dev server that proxies to the other one. It must never hold the key.
    cd /app

    # `dev:hosted`, never `dev`. The plain script is LOCAL mode — it talks to an
    # unauthenticated standalone preview server on port 5273 and never shows a
    # login screen at all. `dev:hosted` is `vite --mode hosted`, which loads
    # editor/.env.hosted and sets VITE_WEBGEN_HOSTED=1.
    #
    # --host 0.0.0.0 because Vite binds 127.0.0.1 by default, which inside a
    # container is the container's own loopback and unreachable from the host
    # however the port is published.
    exec npm run dev:hosted -w editor -- \
      --host 0.0.0.0 \
      --port "${WEBGEN_EDITOR_PORT:-5173}" \
      "$@"
    ;;

  "")
    die "usage: entrypoint.sh <server|editor> [args…]  (or any command to run it directly)"
    ;;

  *)
    # Anything else runs verbatim, so `docker compose run --rm server node
    # scripts/user.ts list --db /app/server/data/identity.db` works. (`docker
    # compose exec` bypasses this entrypoint entirely and does not need it.)
    exec "$@"
    ;;
esac
