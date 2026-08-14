# Website Generator

Type a one-line brief. An agent pipeline generates a complete multi-page site as
typed React source. You edit it on an infinite canvas — text, style, layout,
visibility, section order — and regenerate individual sections without losing
your edits. Then you export a zip of developer-handover-quality code that matches
the preview pixel-for-pixel on every node you touched.

**You run the whole stack on your own machine, with your own API key.** There is
no shared server; nothing you type and nothing you generate leaves your computer
except the model calls themselves.

**Read ["What to expect"](#what-to-expect) before you press Generate.** A
generation spends real money on your key, it cannot be cancelled, and several of
its behaviours look like bugs but are not — including one that makes your *first*
run fail for free.

---

## Two ways to run it

| | [**Docker**](#run-it-with-docker-the-recommended-path) | [**From source**](#run-it-from-source-contributors-and-tests) |
|---|---|---|
| Install on your machine | Docker Desktop | Node 22.18+, uv, and a C-free build of everything |
| Commands to start it | one (`docker compose up`) | two long ones, in two terminals |
| Generation | **proven working on Linux** — a full 2-route site generated inside the container, end to end, from a brief typed into a browser | proven working on Windows |
| Can run `npm run check`, the Playwright suites | no (the image ships no browsers) | **yes — this is the contributor path** |
| Who it is for | testers, and anyone who just wants to use the thing | contributors, and anyone changing the code |

Docker is the recommended path and everything below the Docker section applies to
both. The from-source path is intact and is still the only way to run the test
suites — it has just moved [further down](#run-it-from-source-contributors-and-tests).

---

# Run it with Docker (the recommended path)

## What you need

| | |
|---|---|
| **Docker Desktop** | That is the whole list. No Node, no Python, no uv on the host — the image carries Node 24, a uv-managed CPython 3.12, and `uv` itself. |
| **RAM for Docker** | **4 GB or more.** Measured on a 3.8 GiB VM: the server container peaks around 825 MiB during a generation, when page fan-out was running 2 workers. Fan-out now defaults to **serial**, one worker, which is strictly less memory (see [`WEBGEN_FANOUT_MAX_WORKERS`](#docker-notes-worth-knowing-before-they-surprise-you)). Below 4 GB, workers get killed with no output. |
| **Disk** | ~1.6 GB for the image, plus **~240 MB** of `node_modules` volumes — five named volumes, filled once and shared by both services. Docker's own free space is what matters, not your C: drive; this machine's VM reported 925 GB free. |
| **An API key** | Anthropic (`sk-ant-…`, <https://console.anthropic.com/>) or Google Gemini (`AIza…`, <https://aistudio.google.com/app/apikey>). It needs credit on it: **a generation costs $1.45–$2.58** depending on how many pages the plan comes back with. |

Every command below is written for **bash / zsh** (macOS, Linux, or Git Bash on
Windows). Windows PowerShell equivalents are noted where they differ.

> **On Git Bash, every `docker compose exec` below needs `MSYS_NO_PATHCONV=1` in
> front of it.** MSYS rewrites a leading `/app` into a host path, so
> `--db /app/server/data/identity.db` silently becomes
> `--db "C:/Program Files/Git/app/server/data/identity.db"` — a *second, empty*
> database, in which the CLI cheerfully reports `no users` and creates accounts
> the server never reads. It also leaves a stray
> `server/C:/Program Files/Git/...` directory inside your own repo. Measured, not
> theorised. `MSYS_NO_PATHCONV=1` is necessary and sufficient; running the `exec`
> commands from PowerShell instead also works.

## 1. Generate a master key — once, and never again

The server encrypts your stored API key with AES-256-GCM under a master key it
reads from an env file called `.env.docker`, next to `compose.yaml`. It refuses
to boot without it, and there is no default.

```bash
printf 'WEBGEN_MASTER_KEY=%s\n' "$(openssl rand -base64 32)" > .env.docker
```

Windows PowerShell, if you have no `openssl`:

```powershell
$b = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
"WEBGEN_MASTER_KEY=$([Convert]::ToBase64String($b))" | Set-Content -NoNewline .env.docker
```

> **If `.env.docker` already exists, do not run that command.** It overwrites the
> key, and **every API key already saved becomes permanently undecryptable.**
> Nothing fails at boot when the key changes — the key is only used later, when
> the server tries to decrypt, and the old ciphertext cannot be recovered by any
> means. Keep the file; back it up if you care about the account.

> **It must be canonical, padded base64 — not hex.** This is the single most
> misleading error in the whole setup. A 64-character hex string *passes* the
> base64 validity check (every hex character is in the base64 alphabet, and 64
> characters need no padding) and fails only on **length**:
>
> ```
> WEBGEN_MASTER_KEY must decode to exactly 32 bytes (got 48).
> ```
>
> That reads like "wrong key", so people generate another hex key and hit it
> again. It means "wrong *encoding*". base64url and unpadded base64 are rejected
> too, with a different message. Use the command above and it is right by
> construction.

`.env.docker` is gitignored (`/.env.*`, anchored so it does not also cover the
deliberately committed `editor/.env.hosted`), so the key cannot be committed by
accident.

## 2. Start the stack

```bash
docker compose up
```

That stays attached and streams both services' logs, which is what you want the
first time — the progress below is all visible. If you would rather have one
yes/no answer than a log stream, `docker compose up --wait` returns only when
**both** services report healthy and exits non-zero if either fails to get
there; it implies `-d`, so it hands you back your prompt instead of streaming.

### What a first start looks like, and how to tell it from a hang

The first start is slow, and most of the slowness is silent. Knowing which
silence is normal is the difference between waiting two minutes and giving up
after fifty. Measured on this machine (Docker Desktop 4.49.0, Windows 11, NVMe):

| Phase | What compose prints | First run | Every run after |
|---|---|---|---|
| Build the image | live `#22 [stage-1 13/16] RUN uv sync …` progress, continuously | **118 s** | skipped entirely |
| Create the five `node_modules` volumes | `Volume websitegenerator_root_node_modules Created`, ×5 | ~1 s | skipped (reused) |
| Fill them from the image | `Container … Creating`, then **nothing at all** until it is done | 3–9 s | 0 s |
| Start both, wait for health | `Created` → `Healthy`, one line each | 8–12 s | 8–12 s |
| **Total** | | **~2.3 min** | **12–13 s** |

Those are measured ranges across six starts, not estimates — wall clock from `up`
to both services healthy. The build figure is a separate `--no-cache` build with
the `node:24-bookworm-slim` and `uv` base images already pulled; a genuinely
first-ever run adds their download (~410 MB) to it. The 1.62 GB image size is
unchanged.

So the honest summary is: **the first start is a ~2 minute build with a live
progress bar, followed by ~20 seconds of mostly-silent container setup. Every
start after that is 12–13 seconds.** If you are past the build and it has been
silent at `Container … Creating` for more than about two minutes, something is
wrong — that phase measured 3–9 seconds here, and 0 on every start after the
first.

To check whether a quiet stack is working or stuck, from a second terminal:

```bash
docker compose ps                 # per-service: starting / healthy / exited
docker compose logs -f            # both services, live
docker stats --no-stream          # CPU and block-I/O moving means work is happening
```

A dependency failure is loud and fast, not a hang. If the server cannot boot —
by far the most likely cause being a missing master key — you get the
entrypoint's full explanation, then `dependency failed to start: container
websitegenerator-server-1 exited (1)`, and `up` exits non-zero. Measured at 4.8 s
from `up` to that message.

Two services come up from one image: the **server** on port 4000 and the
**editor**'s Vite dev server on port 5173. Both are published on `127.0.0.1`
only, not `0.0.0.0` — this is a single-user local tool whose session cookie
deliberately drops the `Secure` flag, and putting it on your LAN would be wrong.
The editor waits on the server's healthcheck, so when both are up the stack is
genuinely ready. You should see roughly:

```
server-1  | shutdown budget: grace 30000ms (preview-cleanup watchdog 28000ms, proxied-job wait 25000ms)
server-1  | code version: <a git sha>
server-1  | server listening on http://localhost:4000 (db: /app/server/data/identity.db)
server-1  | INSECURE_COOKIES=1 — Secure flag omitted; local development only
editor-1  |   VITE v8.1.5   hosted   ready in 267 ms
```

Leave it running. Every command from here on goes in a **second terminal**.

Preview iframes get **no published port**. The server spawns one Vite child per
open project inside its own container and reverse-proxies it at
`/preview/<projectId>/*` behind an ownership check; publishing a port for those
children would route around that check.

## 3. Create your account

There is no sign-up page, and there never will be: **no HTTP route in this
codebase may create a user.** Account creation exists only in the operator CLI,
which is what makes invite-only a property of the code rather than a feature
nobody got round to. Under Docker that CLI is one `exec`:

```bash
docker compose exec server node scripts/user.ts create --email you@example.com --db /app/server/data/identity.db
```

On **Git Bash**, exactly as warned above:

```bash
MSYS_NO_PATHCONV=1 docker compose exec server node scripts/user.ts create --email you@example.com --db /app/server/data/identity.db
```

It prints a generated password:

```
created you@example.com
  password: <a generated password>
  (shown once — it is not stored in plaintext)
```

**Copy that password now.** It is shown once and stored only as an argon2id
hash. You cannot supply your own (`--password` is refused, because a password on
the command line lands in your shell history). If you lose it, `reset-password`
prints a new one:

```bash
docker compose exec server node scripts/user.ts reset-password --email you@example.com --db /app/server/data/identity.db
```

> **Always pass `--db /app/server/data/identity.db`.** Both the CLI and the
> server resolve a *relative* `--db` against the current working directory, and
> two different working directories silently give you two different database
> files: your account exists in one, the server reads the other, and login fails
> with the deliberately uniform `invalid email or password`, which tells you
> nothing about there being two files. (A `--db` with its value *left off* is
> refused outright — `--db requires a value`, exit 1 — including the
> easy-to-miss `--db --email you@example.com`, where the next flag counts as no
> value rather than as a path. So the empty-flag version of this cannot happen
> silently; only the relative-path version can.)

## 4. Set a spend cap

New accounts get a **$10** cap per rolling 24 hours — about four to seven
generations. Set it to whatever you are actually willing to spend:

```bash
docker compose exec server node scripts/user.ts set-cap --email you@example.com --usd 25 --db /app/server/data/identity.db
```

> **The flag is `--usd`, not `--cap`.** Using `--cap` produces
> `--usd must be a non-negative number`, which reads like a bad *value* rather
> than a wrong flag name.

Check it any time:

```bash
docker compose exec server node scripts/user.ts usage --email you@example.com --db /app/server/data/identity.db
```

## 5. Log in, and paste your API key into the form

Open <http://localhost:5173/> and log in with the email from step 3 and the
password it printed.

A failed login always says exactly `invalid email or password`, whatever went
wrong — unknown address, wrong password, or a disabled account. That is
deliberate: a more specific message would let someone find out which accounts
exist.

**With no key stored, logging in takes you straight to "Your API key".** That is
on purpose: the alternative is discovering the missing key by pressing a button
that spends money. Pick your provider — **Anthropic** or **Google Gemini** — and
paste the key into the password field.

There is no `curl` in this step any more. What you get back is a fingerprint:

```
Anthropic · ••••AbCd
```

The last four characters are the only part of your key that is ever readable
again; everything else is AES-256-GCM ciphertext under your master key. The field
clears itself after the save, and the key is never echoed, never held in state,
and never logged.

Once a key is stored the form stops appearing on its own. The way back to it is
**"Change API key"**, beside your email at the top of the sites list. From there
you can **Replace** or **Remove** it.

> **Read the Gemini caveat before choosing that provider.** Gemini keys work, but
> Gemini spend is **not bounded by your cap** — see
> ["What to expect"](#what-to-expect).

> **`orchestrator/.env` is a different thing and you do not need it.** The
> pipeline reads its key from the environment, and the server injects your stored
> key per run, scrubbing any inherited `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`
> first, specifically so a run cannot silently spend somebody else's key. An
> `orchestrator/.env` file matters only if you run the Python CLIs directly,
> outside the web app.

## 6. Generate your first site

You land on **your sites** — an empty list, plus a "Generate a new site" form
showing how much of your daily budget is left. Type a one-line brief, e.g.:

```
a landing page for a neighbourhood bakery, with a menu and an order form
```

**Before you press "Generate site", read the next section.** That button spends
$1.45–$2.58 of your own money, takes about nine to eleven minutes, and there is
no way to take it back. Naming the number of pages you want in the brief itself
("exactly two pages: a home page and a contact page") is the one lever you have
over both figures.

Once it starts you get a progress screen: the current stage, how many sections
are done, and an elapsed clock. When it finishes, open the project and you are on
the canvas. Editing, regenerating and exporting all work inside the container —
the export runs a real typecheck, all seven validation gates and a production
`vite build`, and hands you a zip.

## Stopping, restarting, and where your data lives

```bash
docker compose down     # stops; your account, key and sites all survive
docker compose up       # same master key, same data
```

Nothing that matters lives in a Docker volume. The repo is bind-mounted, so
`server/data/identity.db` (accounts, argon2 hashes, sessions, your encrypted key)
and `generated/` (every site you have made) are ordinary files in your own
checkout — visible, backup-able with a file copy, shared with the from-source
path, and **not destroyed by `docker compose down -v`.** That was verified by
removing and recreating the containers twice, including with `-v`: the account
survived, and the stored key still decrypted through the production decrypt path.

The only volumes are five **named** ones over each `node_modules`, which exist to
stop your host's Windows/macOS native binaries from shadowing the image's Linux
ones. You can always see exactly which volumes belong to this project:

```bash
docker volume ls --filter label=com.docker.compose.project=websitegenerator
```

`docker compose down` keeps them, which is why every start after the first skips
the fill phase entirely and takes ~13 s rather than ~22. After a **dependency
change** you want them gone, so the image's fresh install can repopulate them:

```bash
docker compose down -v && docker compose up --build
```

`-v` is safe here *because* the data is bind-mounted. It discards exactly those
five volumes, by name, and nothing else on your machine — compose prints each one
as it goes. A volume is only refilled from the image while it is empty, so
without the `-v` a stale dependency tree survives and produces a confusing
"module not found" a month later.

> **These volumes used to be anonymous, and that was a bug worth understanding if
> you started this stack before.** An anonymous volume is per-container and is
> never reused across a `down`/`up`: each `up` created **ten** fresh ones (five
> per service) and copied `node_modules` into every one of them, and a plain
> `docker compose down` — which does not take `-v` — left all ten behind as
> dangling volumes that nothing could name again. Measured: 10 new orphans and
> ~478 MB per cycle, and one dogfood run accumulated **92 orphaned volumes,
> 3.39 GB**. It also made `up` take 27–61 s instead of 13 s, most of it silent at
> `Container … Creating`, which is what got reported as a hang.
>
> If you were running the old stack, note that switching to this one strands one
> final set of ten: compose recreates the containers because the config changed,
> and the anonymous volumes their predecessors held are detached rather than
> deleted. Running `docker compose down -v` **before** you pull avoids that.
>
> Orphans you already have are stranded for good: `docker compose down -v` cannot
> reach a volume that is already detached, and an anonymous volume carries no
> project label, so there is nothing to filter on. Look at what you have first:
>
> ```bash
> docker volume ls --filter dangling=true
> ```
>
> On Docker 23.0 and later, `docker volume prune` (**without** `-a`) removes only
> *anonymous* unused volumes, so it will not touch any named volume — yours or
> another project's. It **will** remove other projects' anonymous volumes, so
> read that list before you run it, and never use `-a`.

## The `docker compose exec` commands you will want

All of them need `MSYS_NO_PATHCONV=1` in front on Git Bash.

```bash
docker compose exec server node scripts/user.ts list          --db /app/server/data/identity.db
docker compose exec server node scripts/user.ts list-projects --db /app/server/data/identity.db
docker compose exec server node scripts/user.ts usage     --email you@example.com --db /app/server/data/identity.db
docker compose exec server node scripts/user.ts clear-key --email you@example.com --db /app/server/data/identity.db
docker compose exec server node scripts/user.ts disable   --email you@example.com --db /app/server/data/identity.db
docker compose logs -f server
```

## Docker notes worth knowing before they surprise you

- **Never paste `docker compose config` output anywhere.** It prints
  `WEBGEN_MASTER_KEY` in plaintext.
- **`WEBGEN_FANOUT_MAX_WORKERS` is deliberately *not* set in `compose.yaml`.**
  Unset now means **serial** — one page worker at a time — because parallel
  fan-out raced Kitaru's SQLite metadata store and lost a manifest commit, which
  ships a section's `.tsx` with no manifest entry: the site looks finished in the
  canvas and can never be exported. `compose.yaml` used to set this to `2` to
  avoid an out-of-memory kill, and that setting caused the worse failure. Serial
  is slower and visible; the alternative was silent and unfixable. Raising it
  reopens that race, and separately reopens the memory problem it was originally
  set for: measured in this image with 4 routes and no cap, two of the four
  workers were killed with **empty stdout and empty stderr**, surfacing only as
  `manifest CLI produced no result`, which reads like a compiler bug rather than
  the memory exhaustion it was. Each worker is a whole Python process that shells
  out to `tsc`, so the binding constraint is memory, not CPU.
- **The container runs as root**, which is what avoids bind-mount ownership
  problems on Windows. Acceptable for a single-user local tool; not a model for a
  deployment.
- **The image ships no Playwright browsers**, so the two end-to-end suites cannot
  run inside it. See [Running the tests](#running-the-tests).
- **`compiler/src/preview.test.ts` binds port 5173**, which is the editor
  service's published port. With the Docker stack up, that suite fails with
  `Port 5173 is already in use` — so `docker compose down` first, or the host's
  test suite is unrunnable while Docker is running.
- **Editor hot-reload does not fire for source edits on a Windows bind mount**
  (inotify does not cross it). Irrelevant to testers; the from-source path
  remains the contributor path.
- **Sites generated earlier by the from-source path on Windows will not preview
  in the container.** Their borrowed `node_modules` is a Windows junction, which
  Docker Desktop surfaces as a symlink into `/mnt/host/...` that is not in the
  container's mount namespace. Newly generated sites are fine; old ones need
  relinking.
- **`WEBGEN_BOOTSTRAP_EMAIL`** (optional, in `compose.yaml`) adopts existing
  directories in `generated/` for that account so they appear in the picker. It
  cannot create a user — an address matching no account is a logged skip.
- **If the server refuses to boot with `--projects-root and the orchestrator's own output directory disagree`, that is a guard working, not a bug.** The
  entrypoint passes `/app/generated` explicitly, and the Python pipeline
  hardcodes the same path; the refusal exists because the alternative is a paid
  generation landing where nothing looks for it and still reporting success.

---

## What to expect

Everything in this section applies to both paths.

**A generation costs $1.45–$2.58 and takes about nine to eleven minutes.** Both
figures are measured from real runs on real keys, not estimated: **$1.4516689
across 18 billed calls in 9m 09s** for a 2-route site, and **$2.5774346 across 29
calls** for a 4-route one. Cost scales with the number of pages the planner
returns and with how many sections need a retry — one run spent a third of its
bill on three attempts at the design system alone. The app's own warning says
"about $1.74 and about 11 minutes", which is the middle of that range; treat the
range as the truth. **It is your key and your money.**

**Your first generation in a freshly created container will probably fail in
about 13 seconds, having spent $0.00. Submit the brief again and it works.** This
is expected and it is not a bug in the pipeline. `orchestrator/.kitaru/` is
gitignored host state that the bind mount carries into the container, so a stack
id written on the host (or by a previous container) reaches a container whose own
Kitaru database was created fresh and does not have it. Kitaru refuses to run
rather than silently falling back to a different stack, rewrites the config
through the mount to ids that do resolve, and the next submission gets past it.
Verified end to end: the job goes to `failed`, `usage_event` gets **zero** rows,
the CLI reports `$0.00 spent`, and the browser's budget line is untouched. If you
have never run the from-source path, you may not see it at all.

**There is no cancellation.** A mistyped brief spends anyway. The pipeline runs
as a subprocess that cannot be safely killed mid-run — stopping it partway would
leave the project half-written and the spend unrecorded, which is worse. Closing
the browser tab does not stop it either. Re-read your brief before pressing the
button.

**Reloading the page is safe.** The run is server-side, and the progress screen
restores itself from the job id. It is *not* a reason to press Generate again —
you would pay twice.

**`interrupted` means the outcome is UNKNOWN, not failed.** If the server
restarts while a run is going, its job becomes `interrupted`, and the server logs
`marked N running job(s) interrupted after restart` at the next boot. This is
routine, not rare — every restart during a run produces it, and under Docker
`docker compose down` is a restart. The server genuinely cannot know whether the
subprocess finished: the site may be complete, partly written, or untouched. Open
your list of sites and look before spending again.

**`succeeded` means the request completed, not that everything passed.** A
generation that shipped a section as a placeholder is `succeeded`. A failed
export is a `succeeded` job whose result says otherwise. Read what the UI shows
you, not just the status.

**A section can ship as a grey placeholder box.** If a section fails its
validation gates on all 3 attempts, it ships as a `FailedSectionPlaceholder`
instead of failing the whole run — a partial site you can fix beats a nine-minute
run thrown away. This happened in the proof run: **8 of 9 planned sections
generated**, and the ninth asked for icon names the generated icon set did not
contain. The finished-run screen names which sections those were.

**You cannot click a placeholder to fix it.** It deliberately carries no node id
— an invented one would fail a validation gate — so the canvas cannot select it.
The remedy is to **regenerate the whole page** that contains it, which costs
model money again, roughly in proportion to the number of sections on that page.

**Gemini spend is not bounded by your cap, and the UI will tell you when your
figure is a floor.** `orchestrator/src/orchestrator/pricing.py` has published
rates for the Anthropic models this pipeline uses and **none for Gemini**, so a
Gemini call records its token counts with **no cost** (`NULL`, deliberately, not
`0.0`). Your 24-hour total is then a **floor**, not a total — and on a
**Gemini-only account the cap never stops you at all.** SQL `SUM` skips `NULL`,
so if every call in the window was unpriced the total stays `0` and
`checkSpendCap` keeps answering "allowed" at any real spend, forever. On a mixed
account it stops you only on the Anthropic portion. An earlier draft of this
section said the cap "will stop you eventually"; that was wrong, and the
whole-branch review caught it.
Wherever spend is shown, the wording changes to say you have spent *at least*
that much whenever any call in the window was unpriced. This is an accepted
trade — both providers shipped, with the gap surfaced rather than hidden — and it
is tracked in [docs/pending.md](docs/pending.md). **If you want the cap to mean
what it says, use an Anthropic key.**

**Accounts are created only by the operator CLI.** There is no sign-up, and no
password reset by email — `reset-password` is the whole recovery story. This is
invite-only by construction, not an unimplemented feature.

**Set a spend cap before your first run.** Over the cap, the server refuses with
**402**, not 429 — retrying will not help until the 24-hour window rolls. The
refusal happens before anything is created, so nothing is charged and no
half-project is left behind. Exports are deliberately *not* capped: refusing an
export over the cap would strand your finished work behind a bill.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `WEBGEN_MASTER_KEY must decode to exactly 32 bytes (got 48)` | You used a hex key. It must be base64 — see [Docker step 1](#1-generate-a-master-key--once-and-never-again) or from-source step 3. |
| `WEBGEN_MASTER_KEY is not set, so the server will not start.` | Docker: `.env.docker` is missing or empty. **If this is a restart, do not generate a new key** — put the original value back. From source: new shell; re-export it. |
| The CLI reports `no users` right after you created an account | Git Bash mangled the container path. Prefix `MSYS_NO_PATHCONV=1`. Check for a stray `server/C:/Program Files/Git/...` directory in your repo and delete it. |
| `--usd must be a non-negative number` | You probably wrote `--cap`. The flag is `--usd`. |
| `--db requires a value` | You passed `--db` with nothing after it, or with another flag straight after. Both `serve.ts` and `user.ts` **refuse and exit 1** rather than falling back to the default path. |
| `invalid email or password`, but you are sure it is right | Almost always two database files. Under Docker, that means a missing `MSYS_NO_PATHCONV=1`. From source, compare the path the server logged on its `server listening on …` line against the `--db` you gave the CLI. |
| `no user with email …` from the CLI | Same cause, other direction: the CLI is looking at a different `--db`. |
| `job worker refused to start: --projects-root and the orchestrator's own output directory disagree` | The guard doing its job. Under Docker the entrypoint passes the right value, so this should not happen; from source, pass `--projects-root "$WEBGEN_REPO/generated"`. The message names both paths it compared. |
| A brief fails in ~13 seconds having spent nothing, mentioning a Kitaru stack | Expected on the first generation in a fresh container. Submit it again — see ["What to expect"](#what-to-expect). |
| `no API key is stored for this account, and a generation cannot run without one.` | You pressed Generate with no key saved. The message names where to fix it: **"Change API key", beside your email on the sites list**. Nothing was created and nothing was charged. |
| `no model-provider API key: save one in settings, or supply one with this request` | The same cause, from a regenerate / add-section / edit-by-prompt request rather than from a generation. "Settings" is the **"Your API key"** screen, reached by "Change API key" on the sites list. |
| A generation job fails immediately with an authentication error from the provider | The stored key is wrong, has no credit, or is the wrong provider's key for the provider you selected. Replace it on the API key screen. |
| `the stored API key can no longer be read and must be re-entered` | The server booted with a different `WEBGEN_MASTER_KEY` than the one your key was stored under. Either put the original master key back, or save the API key again under the new one. |
| A finished run says a section shipped as a placeholder | Designed behaviour. Regenerate the **page**, not the section — the placeholder cannot be selected. See ["What to expect"](#what-to-expect). |
| `Port 5173 is already in use` while running the tests | The Docker editor service has it. `docker compose down` first. |
| `could not listen on port 4000: … EADDRINUSE` | Something else has the port. From source, add `--port 4001` and start the editor with `WEBGEN_HOSTED_SERVER_URL=http://localhost:4001 npm run dev:hosted -w editor` so its proxy follows. Under Docker, change the published port in `compose.yaml`. |
| `Unknown file extension ".ts"` | From-source only: Node is older than 22.18. |
| The editor shows a canvas, or an endless spinner, instead of a login form | From-source only: you started it with `npm run dev -w editor` (local mode). Use `dev:hosted`. |
| The account "does not exist" afterwards, though the CLI reported success | Not a dropped `--db` value (both CLIs refuse that outright) — a *relative* one, resolved against two different working directories, or a mangled one under Git Bash. |
| An old generated site opens to a blank canvas under Docker | Its borrowed `node_modules` is a Windows junction the container cannot follow. Sites generated *in* the container are fine. |

---

# Run it from source (contributors and tests)

This is the path `npm run check`, both Playwright suites and every contributor
use. It is fully supported and is the only way to run the test suites. If you
only want to *use* the product, [Docker](#run-it-with-docker-the-recommended-path)
is less work.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **22.18 or newer**; **24 is what this is developed and tested on** | `server/`'s `engines` field asks for `>=22.13` — that is where `node:sqlite`, which the identity store uses, stopped needing a flag. But it is not the whole floor: every entry point in this repo is a **`.ts` file run directly by `node`**, and Node only strips TypeScript types without a flag from **22.18** (and 23.6). Below that you get `Unknown file extension ".ts"`, which does not mention Node's version at all. Measured against real containers: 22.13 and 22.17 fail; 22.18 and 24 pass. |
| **uv** | any recent (0.5+) | Runs the Python orchestrator. See [the uv install instructions](https://docs.astral.sh/uv/getting-started/installation/). |
| **Python** | *nothing to install* | `orchestrator/pyproject.toml` pins `>=3.12,<3.13`, and `uv` downloads that interpreter itself. You do not need Python on your PATH. |
| **An API key** | `sk-ant-…` or `AIza…` | See the [Docker prerequisites](#what-you-need) for links and cost. |

Check what you have:

```bash
node --version    # must be >= 22.18
uv --version
```

### A note on shells

Every command below is written for **bash / zsh** (macOS, Linux, or Git Bash on
Windows). If you are on Windows PowerShell, the commands are identical except
for setting variables — see [PowerShell equivalents](#powershell-equivalents) at
the end.

## 1. Clone and install

```bash
git clone <this repo>
cd <the directory it cloned into>
npm install
```

`npm install` at the repo root installs all three JavaScript workspaces
(`compiler/`, `editor/`, `server/`). Do not run `npm install` inside a
subdirectory.

Then, from the repo root, set two variables that the rest of this guide uses.
**Keep this shell open** — you will need them again.

```bash
export WEBGEN_REPO="$PWD"
export WEBGEN_DB="$WEBGEN_REPO/server/data/identity.db"
```

> **Why an absolute path for the database?** Both `server/scripts/user.ts` and
> `server/scripts/serve.ts` default `--db` to `./data/identity.db`, resolved
> **against the current working directory**. Run the CLI from the repo root and
> the server from `server/` and you silently get **two different database
> files**: your account exists in one, the server reads the other, and login
> fails with the deliberately uniform `invalid email or password` — which tells
> you nothing about there being two files.
>
> Both commands **do** refuse a `--db` whose value was left off (`--db requires
> a value`, exit 1), including the easy-to-miss case of another flag following it
> (`--db --email you@example.com`), which counts as no value rather than as a
> path — so the accidental-empty-flag version of this cannot happen silently. A
> `data/` directory is also gitignored **anywhere** in the tree, not only under
> `server/`, so a database created in the wrong place cannot be committed by
> accident either.
>
> What is still entirely possible is passing a *relative* path — or none at all —
> from two different directories, which is exactly how the two-files problem
> happens. Always pass the absolute path, to every command, and the whole class
> of problem disappears.

## 2. Warm up the Python toolchain

```bash
uv sync --directory orchestrator
```

Optional but recommended. `uv` would do this automatically on first use — which
would otherwise be *in the middle of your first paid generation*, downloading a
Python interpreter and a dependency tree while the clock runs.

## 3. Generate a master key

The server encrypts your stored API key with AES-256-GCM under a master key that
lives **only** in the environment variable `WEBGEN_MASTER_KEY`. The server
refuses to boot without it, and there is no default.

```bash
export WEBGEN_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
echo "$WEBGEN_MASTER_KEY"
```

**Save that value somewhere.** You need the same key every time you start the
server; a different one makes every stored API key undecryptable. It must be
canonical padded base64, not hex — see [the Docker note](#1-generate-a-master-key--once-and-never-again),
which explains why the length error reads like the wrong thing.

## 4. Create your account

There is no sign-up page. Accounts exist **only** through the operator CLI —
that is deliberate and structural, not a missing feature.

```bash
node server/scripts/user.ts create --email you@example.com --db "$WEBGEN_DB"
```

It prints a generated password:

```
created you@example.com
  password: <a generated password>
  (shown once — it is not stored in plaintext)
```

**Copy that password now.** It is shown once and stored only as an argon2id
hash. You cannot supply your own password (`--password` is refused, because a
password on the command line lands in your shell history). If you lose it:

```bash
node server/scripts/user.ts reset-password --email you@example.com --db "$WEBGEN_DB"
```

## 5. Set a spend cap

New accounts get a **$10** cap per rolling 24 hours. Set it to whatever you are
actually willing to spend:

```bash
node server/scripts/user.ts set-cap --email you@example.com --usd 25 --db "$WEBGEN_DB"
```

> **The flag is `--usd`, not `--cap`.** Using `--cap` produces
> `--usd must be a non-negative number`, which reads like a bad *value* rather
> than a wrong flag name.

Check it any time with:

```bash
node server/scripts/user.ts usage --email you@example.com --db "$WEBGEN_DB"
```

## 6. Start the server

In the **same shell** (it needs `WEBGEN_MASTER_KEY`):

```bash
INSECURE_COOKIES=1 npm run serve -w server -- \
  --db "$WEBGEN_DB" \
  --projects-root "$WEBGEN_REPO/generated"
```

Leave this running. You should see roughly:

```
shutdown budget: grace 10000ms (…) — default; set WEBGEN_SHUTDOWN_GRACE_MS to match your supervisor
code version: <a git sha>
server listening on http://localhost:4000 (db: …/server/data/identity.db)
INSECURE_COOKIES=1 — Secure flag omitted; local development only
```

Three things about this command:

- **`INSECURE_COOKIES=1` drops the `Secure` flag from the session cookie**,
  which is what you want when everything is plain HTTP. Strictly speaking you
  can leave it off and still log in: browsers and `curl` both treat `localhost`
  as a trustworthy origin and will store and send a `Secure` cookie over
  `http://localhost` anyway (measured, not assumed). Set it anyway — it costs
  nothing locally, and it is what keeps things working the moment you reach the
  server by anything other than `localhost`. Never set it on a real deployment.
- **`--projects-root` must resolve to this repo's own `generated/` directory,
  and nothing else.** The server refuses to boot otherwise, on purpose: the
  Python pipeline hardcodes its output directory, so a mismatch would spend real
  money writing a site into a directory nothing ever looks at and then report
  success. The default is `../generated` **relative to the current working
  directory**, which happens to be right when npm runs the script from
  `server/` — passing it explicitly means it stays right no matter where you
  launched from. If you get this wrong the server tells you both paths and
  exits.
- **`npm run serve -w server -- …`** — the bare `--` is what passes the flags
  through npm to the script. Without it, npm eats them.

## 7. Start the editor

In a **second terminal**, from the repo root:

```bash
npm run dev:hosted -w editor
```

> **`dev:hosted`, not `dev`.** The plain `dev` script starts the editor in
> **local mode**, which talks to an unauthenticated standalone preview server on
> port 5273 and never shows a login screen at all. `dev:hosted` is
> `vite --mode hosted`, which loads `editor/.env.hosted` and sets
> `VITE_WEBGEN_HOSTED=1`. Its dev server also proxies `/api`, `/__*` and
> `/preview` to the server on port 4000, so your browser only ever sees one
> origin and the session cookie works with no CORS involved.

Open <http://localhost:5173/>.

## 8. Log in and save your API key

Use the email from step 4 and the password it printed. With no key stored you
land on the **"Your API key"** screen; choose Anthropic or Google Gemini and
paste the key. It is exactly the flow [Docker step 5](#5-log-in-and-paste-your-api-key-into-the-form)
describes, including the Gemini caveat and the note about `orchestrator/.env`.

If you would rather script it, the same two facts hold as before: `POST
/api/login` **requires `Content-Type: application/json`** (a form-encoded login
is refused with 400 by design — it is what closes login-CSRF), and `PUT
/api/key` takes `{"apiKey":"…","provider":"anthropic"}`. Delete any cookie jar
you create afterwards; `server/data/` is gitignored in full, so neither it nor
the database can be committed by accident.

## 9. Generate your first site

Same as [Docker step 6](#6-generate-your-first-site), and the same warnings in
["What to expect"](#what-to-expect) apply. Note that fan-out is **uncapped** from
source (`WEBGEN_FANOUT_MAX_WORKERS` unset means one worker per route at once),
which is faster on a developer machine and is the setting the wall-clock figures
were measured under.

## Restarting later

Everything except the database and your stored key is disposable. To come back:

```bash
cd /path/to/website-generator
export WEBGEN_REPO="$PWD"
export WEBGEN_DB="$WEBGEN_REPO/server/data/identity.db"
export WEBGEN_MASTER_KEY="<the same key from step 3>"

# terminal 1
INSECURE_COOKIES=1 npm run serve -w server -- --db "$WEBGEN_DB" --projects-root "$WEBGEN_REPO/generated"

# terminal 2
npm run dev:hosted -w editor
```

**The master key must be the same one.** A new key does not error at boot — it
fails later, when the server tries to decrypt your stored API key. If that
happens, save the API key again on the API key screen.

Generated sites live in `generated/web-<uuid>/` and are disposable; the export
zip is the artefact worth keeping. Note that a project's **id** (what the URL's
`?project=` carries) and its **directory name** are two different UUIDs, so
`generated/<project-id>` does not exist. To see the directories:

```bash
node server/scripts/user.ts list-projects --db "$WEBGEN_DB"
```

## PowerShell equivalents

Only the variable syntax differs.

```powershell
$env:WEBGEN_REPO = $PWD.Path
$env:WEBGEN_DB   = "$($env:WEBGEN_REPO)\server\data\identity.db"
$env:WEBGEN_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:INSECURE_COOKIES = "1"

npm run serve -w server -- --db "$env:WEBGEN_DB" --projects-root "$($env:WEBGEN_REPO)\generated"
```

If you script anything with `curl`, **write `curl.exe`, not `curl`**. In
PowerShell 7 `curl` already resolves to the real `curl.exe` that ships with
Windows 10 and later, so either works; in **Windows PowerShell 5.1** `curl` is an
alias for `Invoke-WebRequest`, which does not understand `-c`, `-b` or `-d` and
fails confusingly. Spelling out `curl.exe` is correct on both.

PowerShell is also the simplest way to avoid the Git Bash path-mangling problem
with `docker compose exec` — it does not rewrite `/app/...`.

---

## Running the tests

**From source**, at the repo root:

```bash
npm run check
```

This runs every package's suite: `compiler/` and `editor/` (vitest), `server/`
(vitest), the orchestrator (pytest, via uv), and the Playwright end-to-end
suites. It never needs a login, an API key, or the server to be running — the
Python suite is structurally offline and cannot make a real API call.

The Playwright suites need browsers the first time:

```bash
npx playwright install chromium
```

Two things will stop this from being green if you are not expecting them:

- **`docker compose down` first.** `compiler/src/preview.test.ts` binds port
  5173, which the Docker editor service publishes; with the stack up, 8 of that
  file's 13 tests fail with `Port 5173 is already in use`.
- **Inside the container, only the four unit suites can run.** The image ships
  no Playwright browsers (`~/.cache/ms-playwright` does not exist), so the
  `compiler` (13 tests) and `editor` (123 tests) end-to-end suites are not
  runnable there. The unit suites are, and do pass:

```bash
docker compose exec --workdir /app server npm test -w server
docker compose exec --workdir /app server npm test -w compiler
docker compose exec --workdir /app server npm test -w editor
docker compose exec --workdir /app server uv run --directory /app/orchestrator pytest
```

> **`--workdir /app` is required**, and the whole-branch review caught its
> absence. The service's `working_dir` is `/app/server` — deliberately, so the
> `scripts/user.ts` commands above are short — but `npm test -w <name>` must run
> from the **workspace root**, and from `/app/server` it fails with
> `No workspaces found`.
>
> **The two Playwright suites cannot run in the container at all**: the image
> installs no browsers, on purpose — they are a test-only dependency and would
> add hundreds of megabytes to an image whose job is to run the product. Run
> `npm run check` on the host for those, with the stack **down** (see below).

One `compiler` test is also known to fail on Linux only — a `tsc` diagnostic
ordering difference against an over-specific assertion, recorded in
[docs/pending.md](docs/pending.md).

---

## Known rough edges

This is a work in progress and the list of what is unfinished, deferred, or
known-broken is maintained deliberately in **[docs/pending.md](docs/pending.md)**.
Read it before filing something — several of the surprising behaviours in this
system are already written down there, with the reason they are still open.

If you hit something that is *not* on that list, that is exactly the report
worth making.

---

## How it fits together

Four packages, one repo:

- **`orchestrator/`** (Python 3.12, uv) — the agent pipeline: intake, planner,
  design system, shell, and a parallel page fan-out that generates each section.
- **`compiler/`** (TypeScript) — the deterministic spine: the manifest service,
  the token deriver, seven validation gates, the exporter, and the preview
  bridge.
- **`editor/`** (React + Vite) — the infinite canvas, the edit channels, and the
  hosted-mode screens you log into.
- **`server/`** (Node, `node:sqlite`) — accounts, sessions, your encrypted API
  key, the spend cap, the job queue, and a per-project preview proxy.

Plus `Dockerfile`, `compose.yaml` and `docker/entrypoint.sh`, which run both
processes from one image. The entrypoint deliberately **never generates
`WEBGEN_MASTER_KEY`**: a convenient default there would make the stack start
beautifully every time and make every previously saved API key silently
undecryptable.

`CLAUDE.md` at the repo root is the orientation document for anyone changing the
code; `docs/` holds the binding specifications.
