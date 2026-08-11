# syntax=docker/dockerfile:1

# One image, both toolchains, because the SERVER SPAWNS PYTHON AT RUNTIME.
#
# `server/src/job-worker.ts` spawns `uv` (`uv run python -m
# orchestrator.acceptance`) with cwd = `orchestrator/`, and
# `server/src/preview-pool.ts` spawns `process.execPath
# compiler/scripts/preview.ts`. So Node, Python 3.12 and `uv` all have to be in
# the RUNNING image — a build-stage-only Python would produce a server that
# boots fine and then fails the first generation with ENOENT.

# ---- uv, pinned, from Astral's own image rather than `curl | sh` ----
# A pinned digest-able tag beats piping a network script into a shell: the
# version is legible in the file, and the build is reproducible.
FROM ghcr.io/astral-sh/uv:0.11.16 AS uv

# ---- the one runtime image ----
#
# NODE 24, and the floor is NOT what `server/package.json`'s `engines` field
# says. Measured on this machine against real containers, not recalled:
#
#   node    node:sqlite            node:module.stripTypeScriptTypes   `node x.ts`
#   22.12   ERR_UNKNOWN_BUILTIN    undefined                          fails
#   22.13   OK                     OK (function)                      fails
#   22.17   OK                     OK (function)                      fails
#   22.18   OK                     OK (function)                      OK
#   24.19   OK                     OK (function)                      OK
#
# `engines: ">=22.13"` is exactly right for the two things it was written for
# (`node:sqlite`, which the identity store imports, and `stripTypeScriptTypes`,
# which `server/src/node-loadable.test.ts` and `compiler/src/node-loadable.test.ts`
# call). It is NOT the whole floor: every entry point in this repo is a `.ts`
# file handed straight to `node` (`scripts/serve.ts`, `scripts/user.ts`,
# `compiler/scripts/preview.ts`), and unflagged type stripping only arrives in
# 22.18. At 22.17 the failure is `ERR_UNKNOWN_FILE_EXTENSION: Unknown file
# extension ".ts"` (every workspace package is `"type": "module"`), which names
# neither Node's version nor TypeScript.
#
# 24 is what CI pins and what this is developed on, so 24 is what ships here.
FROM node:24-bookworm-slim

# git: `server/src/code-version.ts` runs `git rev-parse HEAD` at boot and falls
#   back to the "unknown" sentinel without it — which makes every job resume
#   refuse with 409, since "unknown" is treated as incompatible with everything
#   including itself.
# ca-certificates: the model API calls are HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv

# UV_PYTHON_INSTALL_DIR: uv fetches its own CPython (orchestrator/.python-version
#   pins 3.12; pyproject.toml requires >=3.12,<3.13, and Debian bookworm ships
#   3.11). Pinned to an absolute path OUTSIDE /app so the runtime bind mount
#   cannot shadow the interpreter.
# UV_PROJECT_ENVIRONMENT: same reasoning, and it is the more important of the
#   two — the default `.venv` lives INSIDE orchestrator/, which the bind mount
#   replaces with the host's (Windows) venv. Putting it at /opt/venv means no
#   anonymous volume is needed to protect it, and a Windows `.venv` in the
#   cloned repo is simply never consulted.
# UV_LINK_MODE=copy silences uv's hardlink warning across filesystems.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NODE_ENV=development

WORKDIR /app

# ---------------------------------------------------------------------------
# DEPENDENCY LAYERS, above the source copy, so editing a `.ts` file does not
# re-resolve npm or re-download a Python interpreter.
# ---------------------------------------------------------------------------

# npm workspaces: the root lockfile plus every workspace's own package.json is
# the complete input to `npm ci`. The workspace directories must exist with
# their manifests before npm will link them.
COPY package.json package-lock.json ./
COPY compiler/package.json compiler/
COPY editor/package.json editor/
COPY server/package.json server/
RUN npm ci

# The fixture is a STANDALONE project, not a workspace (CI installs it
# separately for the same reason). Its node_modules is load-bearing at runtime,
# not just for tests: the orchestrator links it into every generated project so
# the preview server and the export verification build have something to
# resolve against.
COPY fixtures/acme-landing/package.json fixtures/acme-landing/package-lock.json fixtures/acme-landing/
RUN npm ci --prefix fixtures/acme-landing

# Python. `--no-install-project` keeps this layer to third-party dependencies
# only, so it survives a change to orchestrator source; the project itself is
# installed after the source copy below.
COPY orchestrator/pyproject.toml orchestrator/uv.lock orchestrator/.python-version orchestrator/
RUN uv sync --directory orchestrator --frozen --no-install-project

# ---------------------------------------------------------------------------
# SOURCE
# ---------------------------------------------------------------------------
COPY . .

# Installs the `orchestrator` package itself into /opt/venv. `--frozen` refuses
# to touch uv.lock, so a build can never silently resolve a different tree than
# the one committed.
RUN uv sync --directory orchestrator --frozen

# `sed` before `chmod`, and both deliberately: this repo has no `*.sh eol=lf`
# rule in .gitattributes and was developed with core.autocrlf=true, so a
# Windows clone checks the script out with CRLF endings and `#!/bin/sh\r` fails
# as "no such file or directory". Normalising here fixes it for every clone
# regardless of the tester's git config, which an .gitattributes line alone
# would not do for an already-cloned tree.
RUN sed -i 's/\r$//' /app/docker/entrypoint.sh && chmod +x /app/docker/entrypoint.sh

# 4000 server, 5173 editor dev server. Preview children are spawned INSIDE this
# container on ephemeral ports and reached only through the server's own
# reverse proxy at /preview/<projectId>/*, so they need no port of their own.
EXPOSE 4000 5173

ENTRYPOINT ["/app/docker/entrypoint.sh"]
