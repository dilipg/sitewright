# Website Generator

Type a one-line brief. An agent pipeline generates a complete multi-page site as
typed React source. You edit it on an infinite canvas — text, style, layout,
visibility, section order — and regenerate individual sections without losing
your edits. Then you export a zip of developer-handover-quality code that matches
the preview pixel-for-pixel on every node you touched.

This guide takes you from a fresh clone to a running system with an account you
can log into. **You run the whole stack on your own machine, with your own
Anthropic API key.** There is no shared server; nothing you type and nothing you
generate leaves your computer except the model calls themselves.

**Read ["What to expect"](#what-to-expect) before you press Generate.** A
generation spends real money on your key, it cannot be cancelled, and several of
its behaviours look like bugs but are not.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| **Node.js** | **22.18 or newer**; **24 is what this is developed and tested on** | `server/`'s `engines` field asks for `>=22.13` — that is where `node:sqlite`, which the identity store uses, stopped needing a flag. But it is not the whole floor: every entry point in this repo is a **`.ts` file run directly by `node`**, and Node only strips TypeScript types without a flag from **22.18** (and 23.6). Below that you get `Unknown file extension ".ts"`, which does not mention Node's version at all. |
| **uv** | any recent (0.5+) | Runs the Python orchestrator. See [the uv install instructions](https://docs.astral.sh/uv/getting-started/installation/). |
| **Python** | *nothing to install* | `orchestrator/pyproject.toml` pins `>=3.12,<3.13`, and `uv` downloads that interpreter itself. You do not need Python on your PATH. |
| **An Anthropic API key** | starts with `sk-ant-` | Get one at <https://console.anthropic.com/>. It must have credit on it — a generation costs about **$1.74**. |

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

---

## Setup

### 1. Clone and install

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

### 2. Warm up the Python toolchain

```bash
uv sync --directory orchestrator
```

Optional but recommended. `uv` would do this automatically on first use — which
would otherwise be *in the middle of your first paid generation*, downloading a
Python interpreter and a dependency tree while the clock runs.

### 3. Generate a master key

The server encrypts your stored API key with AES-256-GCM under a master key that
lives **only** in the environment variable `WEBGEN_MASTER_KEY`. The server
refuses to boot without it, and there is no default.

```bash
export WEBGEN_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
echo "$WEBGEN_MASTER_KEY"
```

**Save that value somewhere.** You need the same key every time you start the
server; a different one makes every stored API key undecryptable.

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

### 4. Create your account

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

### 5. Set a spend cap

New accounts get a **$10** cap per rolling 24 hours, which is about five
generations. Set it to whatever you are actually willing to spend:

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

### 6. Start the server

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
  Python pipeline hardcodes its output directory, so a mismatch would spend
  ~$1.74 writing a site into a directory nothing ever looks at and then report
  success. The default is `../generated` **relative to the current working
  directory**, which happens to be right when npm runs the script from
  `server/` — passing it explicitly means it stays right no matter where you
  launched from. If you get this wrong the server tells you both paths and
  exits.
- **`npm run serve -w server -- …`** — the bare `--` is what passes the flags
  through npm to the script. Without it, npm eats them.

### 7. Give the server your Anthropic API key

**There is currently no settings screen for this**, so it is two `curl` calls.
Do it now — you cannot generate at all without it. `POST /api/generate` checks
for a stored key before it creates anything and refuses with a 400 naming this
step, so a skipped key costs you nothing but a click; but that also means the
Generate button will simply refuse until this is done.

In a **second terminal** (the server is occupying the first), from the repo
root:

```bash
export WEBGEN_REPO="$PWD"

# Log in and keep the session cookie. Content-Type: application/json is
# REQUIRED — a form-encoded login is refused with 400 by design (it is what
# closes login-CSRF).
curl -sS -c "$WEBGEN_REPO/server/data/cookies.txt" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"THE-PASSWORD-FROM-STEP-4"}' \
  http://localhost:4000/api/login

# Store the key. It is encrypted at rest; only the last 4 characters are ever
# readable afterwards.
curl -sS -b "$WEBGEN_REPO/server/data/cookies.txt" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-ant-YOUR-KEY-HERE"}' \
  http://localhost:4000/api/key
```

The first prints `{"id":"…","email":"you@example.com"}`; the second prints
`{"fingerprint":"…"}` — the last 4 characters of your key, which is the only
part that is ever readable again. Then delete the cookie file:

```bash
rm "$WEBGEN_REPO/server/data/cookies.txt"
```

(`server/data/` is gitignored in full, so the cookie jar and the database can
never be committed by accident.)

> **`orchestrator/.env` is a different thing and you do not need it.** The
> pipeline reads `ANTHROPIC_API_KEY` from its environment, and the server
> injects your stored key per run — scrubbing any inherited one first,
> specifically so a run cannot silently spend somebody else's key. An
> `orchestrator/.env` file matters only if you run the Python CLIs directly,
> outside the web app.

### 8. Start the editor

In a **third terminal**, from the repo root:

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

### 9. Log in

You should see a login form. Use the email from step 4 and the password it
printed.

A failed login always says exactly `invalid email or password`, whatever went
wrong — unknown address, wrong password, or a disabled account. That is
deliberate: a more specific message would let someone find out which accounts
exist.

After logging in you land on **your sites** — an empty list, plus a
"Generate a new site" form showing how much of your daily budget is left.

### 10. Generate your first site

Type a one-line brief, e.g.:

```
a landing page for a neighbourhood bakery, with a menu and an order form
```

**Before you press "Generate site", read the next section.** That button spends
about $1.74 of your own money and there is no way to take it back.

Once it starts you get a progress screen: the current stage, how many sections
are done, and an elapsed clock measured against a real ~11-minute run. When it
finishes, open the project and you are on the canvas.

---

## What to expect

**A generation costs about $1.74 and takes about 11 minutes.** Both are
measured, not estimated. It is your key and your money.

**There is no cancellation.** A mistyped brief spends anyway. The pipeline runs
as a subprocess that cannot be safely killed mid-run — stopping it partway would
leave the project half-written and the spend unrecorded, which is worse. Closing
the browser tab does not stop it either. Re-read your brief before pressing the
button.

**Reloading the page is safe.** The run is server-side, and the progress screen
restores itself from the job id. It is *not* a reason to press Generate again —
you would pay twice.

**`interrupted` means the outcome is UNKNOWN, not failed.** If you restart the
server while a run is going, its job becomes `interrupted`, and the server logs
`marked N running job(s) interrupted after restart` at the next boot. This is
routine, not rare — every restart during a run produces it. The server genuinely
cannot know whether the subprocess finished: the site may be complete, partly
written, or untouched. Open your list of sites and look before spending again.

**`succeeded` means the request completed, not that everything passed.** For
edits, regenerations and exports, check the result the UI shows you — a failed
export is a `succeeded` job whose result says otherwise.

**A section can ship as a grey placeholder box.** If a section fails its
validation gates on all 3 attempts, it ships as a `FailedSectionPlaceholder`
instead of failing the whole run. The finished-run screen names which sections
those were, and you can regenerate any of them from the canvas. This is designed
behaviour — a partial site you can fix beats an eleven-minute run thrown away.

**Accounts are created only by the operator CLI.** There is no sign-up, and no
password reset by email — `reset-password` in step 4 is the whole recovery
story. This is invite-only by construction.

**Set a spend cap before your first run** (step 5). Over the cap, the server
refuses with **402**, not 429 — retrying will not help until the 24-hour window
rolls. The refusal happens before anything is created, so nothing is charged and
no half-project is left behind.

---

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
happens, re-run step 7 to store the key again under the new master key.

Generated sites live in `generated/web-<uuid>/` and are disposable; the export
zip is the artefact worth keeping. Note that a project's **id** (what the URL's
`?project=` carries) and its **directory name** are two different UUIDs, so
`generated/<project-id>` does not exist. To see the directories:

```bash
node server/scripts/user.ts list-projects --db "$WEBGEN_DB"
```

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `WEBGEN_MASTER_KEY must decode to exactly 32 bytes (got 48)` | You used a hex key. It must be base64 — see step 3. |
| `WEBGEN_MASTER_KEY is not set. The server will not start without it.` | New shell. Re-export it (step 3). |
| `--usd must be a non-negative number` | You probably wrote `--cap`. The flag is `--usd`. |
| `job worker refused to start: --projects-root and the orchestrator's own output directory disagree` | Pass `--projects-root "$WEBGEN_REPO/generated"` (step 6). The message names both paths it compared. |
| `invalid email or password`, but you are sure it is right | Almost always two database files — check the path the server logged on its `server listening on …` line against the `--db` you gave the CLI. |
| `no user with email …` from the CLI | Same cause, other direction: the CLI is looking at a different `--db`. |
| `Unknown file extension ".ts"` | Node is older than 22.18. |
| `could not listen on port 4000: … EADDRINUSE` | Something else has the port. Add `--port 4001` and start the editor with `WEBGEN_HOSTED_SERVER_URL=http://localhost:4001 npm run dev:hosted -w editor`, so its proxy follows. |
| The editor shows a canvas, or an endless spinner, instead of a login form | You started it with `npm run dev -w editor` (local mode). Use `dev:hosted`. |
| `no Anthropic API key is stored for this account…` when you press Generate | Step 7 was skipped, or was run against a different database. Nothing was created and nothing was charged. |
| `no Anthropic API key: save one in settings, or supply one with this request` | The same cause, from a regenerate / add-section / edit-by-prompt request rather than from a generation. (Its "in settings" wording is the one screen that does not exist yet — read it as step 7.) |
| A generation job fails immediately with an authentication error from Anthropic | The stored key is wrong or has no credit. Re-run step 7 with a good key. |
| `the stored API key can no longer be read and must be re-entered` | The server booted with a different `WEBGEN_MASTER_KEY` than the one your key was stored under. Either put the original key back, or re-run step 7. |
| `--db requires a value` | You passed `--db` with nothing after it, or with another flag straight after. **Both** `serve.ts` and `user.ts` refuse rather than falling back to the default path. |
| The account "does not exist" afterwards, though the CLI reported success | Not a dropped `--db` value (both CLIs refuse that outright) — a *relative* one, resolved against two different working directories. Compare the path the server logs on its `server listening on …` line with the `--db` you gave the CLI. |

Useful CLI commands, all needing `--db "$WEBGEN_DB"`:

```bash
node server/scripts/user.ts list --db "$WEBGEN_DB"
node server/scripts/user.ts list-projects --db "$WEBGEN_DB"
node server/scripts/user.ts usage --email you@example.com --db "$WEBGEN_DB"
node server/scripts/user.ts clear-key --email you@example.com --db "$WEBGEN_DB"
node server/scripts/user.ts disable --email you@example.com --db "$WEBGEN_DB"
```

---

## Known rough edges

This is a work in progress and the list of what is unfinished, deferred, or
known-broken is maintained deliberately in **[docs/pending.md](docs/pending.md)**.
Read it before filing something — several of the surprising behaviours in this
system are already written down there, with the reason they are still open.

If you hit something that is *not* on that list, that is exactly the report
worth making.

---

## Running the tests

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

---

## PowerShell equivalents

Only the variable syntax differs.

```powershell
$env:WEBGEN_REPO = $PWD.Path
$env:WEBGEN_DB   = "$($env:WEBGEN_REPO)\server\data\identity.db"
$env:WEBGEN_MASTER_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:INSECURE_COOKIES = "1"

npm run serve -w server -- --db "$env:WEBGEN_DB" --projects-root "$($env:WEBGEN_REPO)\generated"
```

For step 7, **write `curl.exe`, not `curl`**. In PowerShell 7 `curl` already
resolves to the real `curl.exe` that ships with Windows 10 and later, so either
works; in **Windows PowerShell 5.1** `curl` is an alias for `Invoke-WebRequest`,
which does not understand `-c`, `-b` or `-d` and fails confusingly. Spelling out
`curl.exe` is correct on both. Alternatively, run step 7 from Git Bash.

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

`CLAUDE.md` at the repo root is the orientation document for anyone changing the
code; `docs/` holds the binding specifications.
