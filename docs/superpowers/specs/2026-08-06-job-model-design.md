# Job model design (slice 5)

**Status:** design, for approval before implementation.

**Extends** `2026-08-04-accounts-byok-tenancy-design.md`. That spec's decision 11 kept long operations synchronous behind a generous proxy timeout and deferred the job model to slice 5 explicitly; "Not in this design" lists both *a job model for long-running work* and *web-triggered generation*. This document is that deferred piece. It does not contradict the spec — it retires a deliberate deferral.

**Decided by the human, 2026-08-06:** job state in SQLite; **every** long-running operation becomes a job (not only generation); the browser learns outcomes by **polling**.

---

## The idea that keeps this small

A job is **a server-side wrapper around the exact same proxied request the server already makes.**

Nothing in `compiler/` changes. The preview child keeps doing the work synchronously, exactly as it does today, with the same 15-minute upstream bound. The only change is *who waits*: instead of the browser holding a request open for five minutes, the server holds it and records the outcome in a row.

That single decision removes most of the cost of "convert everything":

- **No compiler changes.** No job awareness in `regen-api.ts`, no new protocol between server and child.
- **`retain`/`release`, the usage-log id, and ingest move unchanged in shape** into the worker — the same `finally`, the same exactly-once-then-delete, the same skip-when-the-exchange-never-completed. That logic was reviewed hard three times; it is not rewritten, it is relocated.
- **The spend cap and the in-flight reservation keep their existing meaning**, just evaluated at enqueue.
- **The editor changes mechanically**, not conceptually: `await fetch(...)` becomes `enqueue` + `poll`. One helper, five call sites.

What it does *not* buy: fine-grained progress. A job is opaque until it finishes. That is a real regression against today's regen UX, which shows a live progress line, and it is the main thing to weigh — see "Accepted losses".

---

## Data model

One table, appended to `MIGRATIONS` in `server/src/db.ts` (append-only, idempotent, as every migration there must be):

```sql
job  id TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
     project_id  TEXT REFERENCES project(id) ON DELETE SET NULL,
     kind        TEXT NOT NULL,      -- 'generate' | 'regen' | 'regen-page' | 'add-section' | 'edit-prompt' | 'export'
     status      TEXT NOT NULL,      -- 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
     request_json TEXT NOT NULL,     -- the body to replay to the child
     result_json TEXT,               -- the child's response body, on success
     error       TEXT,               -- a redacted message, on failure
     created_at  INTEGER NOT NULL,
     started_at  INTEGER,
     finished_at INTEGER
```

Plus `CREATE INDEX job_user_status_idx ON job(user_id, status)` — every enqueue asks "how many does this user have in flight", and that must not scan every job ever run.

`project_id` is `ON DELETE SET NULL`, matching `usage_event`: deleting a project must not erase the record that work was paid for. `user_id` cascades, consistent with the rest of the schema.

**`request_json` holds the request body, not the response.** It is what the worker replays to the child, and it is why a queued job survives a restart. It must never hold an API key — the body of these endpoints carries a route, a section id and an instruction, and nothing else.

---

## Which endpoints become jobs

"Long-running" means *spawns a subprocess*. Measured: section regen ~27–90s, add-section ~84s, page regen ~5 min, export-with-build several minutes, a full generation ~286s.

| Endpoint | Becomes a job | Why |
|---|---|---|
| `POST /api/generate` (new) | yes | ~286s, and no project exists yet |
| `POST /__regen` | yes | spawns the orchestrator |
| `POST /__regen-page` | yes | ~5 min |
| `POST /__add-section` | yes | ~84s |
| `POST /__edit-prompt` | yes | spawns the edit agent |
| `POST /__export` | yes | production build, several minutes |
| `GET /__export-download` | **no** | streams an existing artifact |
| `POST /__regen-revert` | **no** | a file copy |
| `GET`/`PUT /__overrides*`, `/__plan*`, `/__archetypes` | **no** | file reads and writes |

Six job kinds. The four billable ones plus export plus generation — which is exactly the set that already carries a `billable` flag, plus export, plus the new one. **The registry keeps one flag per endpoint and gains a second: `async: boolean`.** Required, not optional, for the same reason `billable` is required — omitting it must be a compile error, not something a reviewer has to notice.

---

## Endpoints

```
POST /api/generate            -> 202 { jobId }     session-only, billable, async
GET  /api/jobs/:id            -> 200 { status, kind, createdAt, finishedAt, result?, error? }
GET  /api/jobs?project=<id>   -> 200 { jobs: [...] }   the project's recent jobs
POST /__regen?project=<id>    -> 202 { jobId }     (was: 200 with the outcome)
   ...and the other four, identically
```

`GET /api/jobs/:id` is **session-scoped and owner-checked on the job's own `user_id`**, not on the project — a generation job has no project until it succeeds. A job belonging to another user answers **404**, the same shape and the same shared constant `requireProject` uses, so the job id space is not an enumeration oracle either.

**202, not 200.** The work has not happened yet; saying 200 would be a lie a client could reasonably act on.

---

## The worker

One in-process worker loop, not a process pool. It polls the `job` table for the oldest `queued` row whose user is under both bounds, marks it `running`, and performs *exactly the call the synchronous handler makes today*: acquire the preview child, retain, set the usage id, proxy the recorded body, release and ingest in the same `finally`, then write `succeeded` or `failed`.

Bounds, all of which already exist and are simply evaluated at enqueue instead of at request time:
- **Per user: 2 concurrent** — today's in-flight reservation, unchanged in value and meaning.
- **Globally: the preview pool's cap of 6** does double duty, because every job needs a child. A seventh concurrent job across all users waits rather than failing, which is *better* than today's 503.
- **Spend cap: checked at enqueue**, which is what the spec means by "gates starting work only". A job that queues under the cap and starts over it still runs — the spec accepts overshoot for one run, and refusing at start time is the whole point.

**Crash recovery, stated because it cannot be solved:** a row left `running` when the server restarts is marked **`interrupted`**, never retried. The server cannot know whether the child finished the work, and a subprocess that was mid-`write_section_only` may have left a half-written page. Retrying could regenerate a section twice and bill twice; assuming success could report work that never happened. `interrupted` says exactly what is known — the UI shows "this may or may not have completed, check the page" — and the operator CLI can list them. **This is the honest answer, not a placeholder.**

---

## Progress, by polling

`GET /api/jobs/:id` every 2s while a job is `queued` or `running`. That is a few hundred requests for a five-minute generation, which is nothing against one request that holds a socket for the same duration.

Polling is what makes spec decision 13 fall out for free: *work in flight survives disconnect, and the UI reconnects and reads current state rather than assuming its own request's outcome.* With polling, **the next poll IS the reconnect.** There is no resume protocol, no last-event-id, no second long-lived connection competing with HMR.

---

## Accepted losses, written down rather than discovered

1. **Fine-grained progress goes away.** Today's regen shows a live progress line from the streamed response. A job is opaque until it finishes: the UI can show "running" and elapsed time, not "generating section 3 of 6". Recovering it later means either an SSE endpoint or a `progress` column the worker updates — both are additive, and neither should be built now.
2. **The editor's five flows are rewritten.** Mechanical (one `enqueueAndPoll` helper, five call sites) but it touches code proven by the milestone-7 e2e suite, so those specs change with it. This is the cost the human accepted in choosing "convert everything" over "generation only".
3. **A job's result is a stored copy of the child's response.** If the child's response shape changes, old rows hold the old shape. Acceptable because nothing reads a finished job's result except the UI that just submitted it.
4. **`interrupted` is a real state a user will see**, not a rare one — every deploy during a run produces one.

---

## What is explicitly out

- No retry, no backoff, no dead-letter queue. A failed job is failed; the user resubmits. Retrying model work automatically is how a spend cap gets defeated.
- No priority, no fairness beyond the per-user bound.
- No cancellation. The subprocess cannot be safely killed mid-run — spec decision 13 — so a cancel button would either lie or corrupt a page.
- No cross-process worker. One server, one loop; the pool's cap of 6 is the real limit anyway.

---

## Resolved: the project row is created at enqueue

**Decided by the human, 2026-08-06.** `POST /api/generate` creates the `project` row and its directory before the job is queued, so the job carries a `project_id` throughout.

A failed generation therefore leaves a project the user can see and delete, rather than a partially-generated directory owned by nobody — which is exactly the orphaned-acceptance-run problem slice 4a had to write an adoption pass to clean up once already. An owned failure beats an unowned one.

Consequence to build for: **a project can exist with an empty or partial directory.** Anything that assumes a project row implies a servable site must tolerate it — in particular the preview pool, which will be asked to spawn a Vite child for a directory that has no `vite.config.ts` yet, and must fail with something legible rather than a spawn timeout.

## One asymmetry this design does not paper over

Five of the six job kinds are wrappers around a proxied request to the project's preview child. **`generate` is not**, and cannot be: there is no site for a Vite dev server to serve until generation has run. The server spawns the orchestrator directly for that kind, using the `buildAgentEnv` / usage-log / `redactSecrets` machinery the preview pool already uses for its children.

So the worker has two execution strategies behind one job table, not one. That is honest and small — but it is not the uniformity "convert everything" might imply, and pretending otherwise would mislead whoever implements it.
