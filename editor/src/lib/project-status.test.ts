import { describe, expect, it } from "vitest";
import { explainUnopenableProject } from "./project-status";
import { SessionExpiredError } from "./session-fetch";

/**
 * The gap these cover, from a real tester session: a generation failed at gate
 * 1 with an exact diagnosis, the job row recorded all of it and landed
 * `failed`, and the editor showed a raw Vite overlay plus a panel that GUESSED
 * ("the usual reason is that its generation is still running … or that the
 * generation failed"). Both halves of that guess were facts, one endpoint away.
 */

/** Verbatim from the failed job row, trimmed. The real thing is ~40 lines. */
const REAL_ERROR = `orchestrator exited with code 1

failed stage: fanout
detail.gate_report.gates[0].gate: 1
detail.gate_report.gates[0].name: imports-resolve
detail.gate_report.gates[0].failures[0].reason: unresolved-import
detail.gate_report.gates[0].failures[0].file: src/pages/home/index.tsx
detail.gate_report.gates[0].failures[0].message: Import "./mock/StickyHero.data" in src/pages/home/index.tsx does not resolve to a file.`;

function respondWith(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

const OPTS = { jobsUrl: "/api/jobs?project=p1" };

describe("explainUnopenableProject: the states a tester can be in", () => {
  it("reports a FAILED generation with the server's own diagnosis, verbatim", async () => {
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({
        jobs: [{ id: "j1", kind: "generate", status: "failed", error: REAL_ERROR }],
      }),
    });
    expect(result.state).toBe("failed");
    // Verbatim matters: the value of this whole module is showing the gate
    // report, not a paraphrase of it. A summary would have hidden the file and
    // the specifier, which are the only parts a tester can act on.
    expect(result).toMatchObject({ jobId: "j1", detail: REAL_ERROR });
  });

  it("reports a RUNNING generation as generating, not as a failure", async () => {
    // The opposite action: wait, rather than read an error and regenerate.
    for (const status of ["queued", "running"]) {
      const result = await explainUnopenableProject({
        ...OPTS,
        fetchImpl: respondWith({ jobs: [{ id: "j2", kind: "generate", status }] }),
      });
      expect(result).toEqual({ state: "generating", jobId: "j2" });
    }
  });

  it("keeps INTERRUPTED distinct from failed", async () => {
    // `interrupted` exists precisely so a server restart mid-run is not
    // reported as a failure: the server cannot know whether the child
    // finished, so the UI must say the outcome is unknown. Folding it into
    // `failed` would re-tell the lie that state was created to prevent.
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({ jobs: [{ id: "j3", kind: "generate", status: "interrupted" }] }),
    });
    expect(result).toEqual({ state: "interrupted", jobId: "j3" });
  });

  it("still reports failed when the row carries no error text", async () => {
    // The STATUS is the fact. Suppressing a known failure for want of detail
    // would be the original bug again, in a smaller form.
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({ jobs: [{ id: "j4", kind: "generate", status: "failed" }] }),
    });
    expect(result).toMatchObject({ state: "failed", detail: "" });
  });
});

describe("explainUnopenableProject: what it refuses to claim", () => {
  it("does not blame the generation for a SUCCEEDED job", async () => {
    // A succeeded generation that still will not open is a different problem
    // (a dead preview child, a cross-environment symlink). Claiming the
    // generation failed would be a lie in the opposite direction.
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({ jobs: [{ id: "j5", kind: "generate", status: "succeeded" }] }),
    });
    expect(result).toEqual({ state: "unexplained" });
  });

  it("ignores a failed REGEN or EXPORT — neither explains missing files", async () => {
    // Newest-first ordering means an unrelated later failure sits in front of
    // the generate row. Reporting it would surface a stale, wrong reason.
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({
        jobs: [
          { id: "r1", kind: "regen", status: "failed", error: "gate 7 orphan" },
          { id: "g1", kind: "generate", status: "succeeded" },
        ],
      }),
    });
    expect(result).toEqual({ state: "unexplained" });
  });

  it("uses the NEWEST generate job when a failed one has been retried", async () => {
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({
        jobs: [
          { id: "new", kind: "generate", status: "running" },
          { id: "old", kind: "generate", status: "failed", error: REAL_ERROR },
        ],
      }),
    });
    expect(result).toEqual({ state: "generating", jobId: "new" });
  });

  it("says nothing when there is no generate job at all", async () => {
    // Every adopted acceptance run is in this state: real files, no job row.
    const result = await explainUnopenableProject({
      ...OPTS,
      fetchImpl: respondWith({ jobs: [] }),
    });
    expect(result).toEqual({ state: "unexplained" });
  });
});

describe("explainUnopenableProject: failing to explain must not become the message", () => {
  it("a 401 throws SessionExpiredError instead of reporting a failed generation", async () => {
    // THE most important case here. Telling a tester whose session merely
    // lapsed that their ~$1 generation failed is the exact lie this module
    // exists to stop, and it would be self-inflicted.
    await expect(
      explainUnopenableProject({ ...OPTS, fetchImpl: respondWith({}, 401) }),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("a 404 or 500 resolves unexplained rather than throwing", async () => {
    // This runs only when the caller is ALREADY reporting a problem. Throwing
    // here would replace a real message with an error about fetching an
    // explanation.
    for (const status of [404, 500]) {
      await expect(
        explainUnopenableProject({ ...OPTS, fetchImpl: respondWith({ error: "x" }, status) }),
      ).resolves.toEqual({ state: "unexplained" });
    }
  });

  it("a non-JSON body (a proxy error page) resolves unexplained", async () => {
    await expect(
      explainUnopenableProject({ ...OPTS, fetchImpl: respondWith("<html>502</html>") }),
    ).resolves.toEqual({ state: "unexplained" });
  });

  it("a malformed body resolves unexplained rather than throwing", async () => {
    for (const body of [{}, { jobs: null }, { jobs: "nope" }, { jobs: [{ kind: "generate" }] }]) {
      await expect(
        explainUnopenableProject({ ...OPTS, fetchImpl: respondWith(body) }),
      ).resolves.toEqual({ state: "unexplained" });
    }
  });

  it("sends the project-scoped URL it was given", async () => {
    // `GET /api/jobs` is project-scoped BY_QUERY, so a URL without `?project=`
    // is a 404 that would silently degrade every case above to `unexplained`.
    const seen: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await explainUnopenableProject({ jobsUrl: "/api/jobs?project=p1", fetchImpl });
    expect(seen).toEqual(["/api/jobs?project=p1"]);
  });
});
