import { describe, expect, it } from "vitest";
import {
  EMPTY_BRIEF_MESSAGE,
  loadProjects,
  startGeneration,
  toProjectRows,
} from "./ProjectPicker";
import { SessionExpiredError } from "../lib/session-fetch";
// Vite's own `?raw` suffix rather than `node:fs` — this workspace's tsconfig
// has no node types, and adding `@types/node` for one test would be a new
// dependency. Same precedent as `App.test.ts`.
import pickerSource from "./ProjectPicker.tsx?raw";

/**
 * `.test.ts`, not `.test.tsx` — `ExportPanel.test.ts` and `LoginScreen.test.ts`
 * set the precedent, and task 2 measured why it matters: `vitest.config.ts`
 * once included `src/**\/*.test.ts` ONLY, so a `.test.tsx` file was silently
 * skipped. A test file that exists, reads as coverage and never runs is the
 * one failure mode "every test must fail if the behaviour it names is removed"
 * cannot detect, because a test that does not execute cannot fail.
 *
 * Nothing here mounts a component: this workspace has no React testing library
 * and may not add one ("no new runtime dependencies"). That constraint is
 * exactly why `startGeneration`, `loadProjects` and `toProjectRows` are
 * exported separately from the form — the halves of this screen that can be
 * wrong in a way that matters (the request it makes, and which of a project's
 * two UUIDs it hands back) are the halves testable without a DOM.
 */

/** Records every call the function under test makes, so "did it poll?" and
 *  "did it call at all?" are both answerable. */
function recordingFetch(respond: (url: string, init: RequestInit) => Response): {
  calls: Array<{ url: string; method: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; method: string; init: RequestInit }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", init: init ?? {} });
    return respond(String(url), init ?? {});
  };
  return { calls, fetchImpl };
}

const ACCEPTED = () =>
  new Response(JSON.stringify({ jobId: "j1", projectId: "p1" }), { status: 202 });

/* ------------------------------------------------------------------ *
 * startGeneration: 202 means the work has STARTED, not finished
 * ------------------------------------------------------------------ */

describe("startGeneration: a 202 is the START of the work, never its result", () => {
  it("treats a 202 from generate as the START of work, not a result", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ jobId: "j1", projectId: "p1" }), { status: 202 });
    const started = await startGeneration("a site for a bakery", { fetchImpl });
    expect(started).toEqual({ jobId: "j1", projectId: "p1" });
  });

  it("makes exactly ONE request and never polls — a generation runs ~11 minutes and the progress view owns the polling", async () => {
    // The discriminating half of the test above. `enqueueAndPoll` exists in
    // this codebase and does the opposite: it POSTs, then polls
    // `/api/jobs/:id` until the job reaches a terminal status, resolving with
    // a `JobOutcome` rather than with the ids. Using it here would look
    // correct and read correct — and would block for the whole ~11-minute
    // run before the user saw anything at all, with no progress, no stage
    // and no honest elapsed time. `{jobId, projectId}` alone cannot catch
    // that (a poll loop still ends up holding both ids); the CALL COUNT can.
    const { calls, fetchImpl } = recordingFetch(ACCEPTED);
    await startGeneration("a site for a bakery", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls.some((call) => call.url.includes("/api/jobs/"))).toBe(false);
  });

  it("POSTs the trimmed brief as JSON to /api/generate", async () => {
    const { calls, fetchImpl } = recordingFetch(ACCEPTED);
    await startGeneration("  a site for a bakery  ", { fetchImpl });
    expect(calls[0]!.url).toBe("/api/generate");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ brief: "a site for a bakery" });
  });

  it("refuses ANY status other than 202, because 202 is the one signal that a job now exists", async () => {
    // Same discrimination rule `lib/jobs.ts` already documents: 202 is
    // reserved for "a job now exists, go poll for it", and nothing else means
    // it. A 200 carrying an identical body would be some other server, or a
    // proxy that swallowed the real answer — reading it as a started
    // generation would put the progress view on a job id nothing is running.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ jobId: "j1", projectId: "p1" }), { status: 200 });
    await expect(startGeneration("a bakery site", { fetchImpl })).rejects.toThrow();
  });

  it("surfaces a refusal's own message verbatim (over the spend cap, over the job bound)", async () => {
    // 402 (over cap: retrying cannot help until the window rolls) and 429
    // (two generations already in flight: retrying DOES help) are different
    // situations with different advice, and the server already words both.
    // Rewording here would either lose that distinction or invent one.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "spend cap reached; resets at 2026-08-11T04:00:00Z" }), {
        status: 402,
      });
    await expect(startGeneration("a bakery site", { fetchImpl })).rejects.toThrow(
      new Error("spend cap reached; resets at 2026-08-11T04:00:00Z"),
    );
  });

  it("falls back to naming the status when a refusal carries no message at all", async () => {
    const fetchImpl = async () => new Response("<html>502 bad gateway</html>", { status: 502 });
    let message = "";
    await startGeneration("a bakery site", { fetchImpl }).catch((error: unknown) => {
      message = (error as Error).message;
    });
    expect(message).toContain("502");
  });

  it("a 401 is an expired session, NOT a failed generation", async () => {
    // The lie `interrupted` exists to prevent, arrived at from another
    // direction: reporting "generation failed" for a session that merely
    // lapsed sends the user to debug a run that was never started, and the
    // ~$1.74 they think they lost was never spent.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "not authenticated" }), { status: 401 });
    const error = await startGeneration("a bakery site", { fetchImpl }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SessionExpiredError);
  });

  it("rejects a 202 whose body is not actually a pair of ids", async () => {
    // A 202 from something that is not this endpoint (a proxy, a future
    // shape change) would otherwise hand the progress view
    // `{jobId: undefined}`, which polls `/api/jobs/undefined` forever.
    const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), { status: 202 });
    await expect(startGeneration("a bakery site", { fetchImpl })).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * startGeneration: the empty-brief guard
 * ------------------------------------------------------------------ */

describe("startGeneration: an empty brief never reaches the server", () => {
  it("refuses to submit an empty brief without calling the server", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return new Response("{}", { status: 202 });
    };
    await expect(startGeneration("   ", { fetchImpl })).rejects.toThrow(/brief/i);
    expect(called).toBe(false);
  });

  it("reports the exact guard message, not merely something containing 'brief'", async () => {
    // A substring assertion is not a discriminating assertion (task 2
    // measured that `toThrow(/…/)` still PASSES when the message is
    // perturbed by appending to it). The wording is the point here: it is
    // the whole user-visible outcome of pressing Generate with nothing typed.
    const fetchImpl = async () => new Response("{}", { status: 202 });
    await expect(startGeneration("", { fetchImpl })).rejects.toThrow(new Error(EMPTY_BRIEF_MESSAGE));
  });

  it("treats every flavour of whitespace as empty, and calls the server for none of them", async () => {
    for (const blank of ["", " ", "\t", "\n", "  \n\t  ", "\r\n"]) {
      let called = false;
      const fetchImpl = async () => {
        called = true;
        return new Response("{}", { status: 202 });
      };
      await expect(startGeneration(blank, { fetchImpl })).rejects.toThrow(
        new Error(EMPTY_BRIEF_MESSAGE),
      );
      expect(called, `"${blank}" reached the server`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * toProjectRows: a project's id is NOT its on-disk directory
 * ------------------------------------------------------------------ */

/** Both UUIDs present and unmistakably different, which is the whole point. */
const WIRE_PROJECTS = [
  {
    id: "3f8c1a54-0000-4000-8000-000000000001",
    name: "a bakery landing page",
    directory: "run-9b21e0d4-aaaa-4000-8000-000000000009",
    createdAt: Date.UTC(2026, 7, 3, 11, 30),
  },
  {
    id: "3f8c1a54-0000-4000-8000-000000000002",
    name: "a climbing-gym storefront",
    directory: "run-77c3f1aa-bbbb-4000-8000-00000000000b",
    createdAt: Date.UTC(2026, 7, 9, 8, 0),
  },
];

describe("toProjectRows: the id and the on-disk directory are different UUIDs", () => {
  it("carries the project's ID — the thing the API takes — never its directory", async () => {
    // This codebase's single most repeated mistake. `GET /api/projects`
    // returns BOTH, they are both UUID-shaped, and only `id` is accepted by
    // `?project=` or any `/api/projects/:id` route. Handing a directory to
    // the editor produces an authorization 404 that looks exactly like a
    // deleted project.
    const rows = toProjectRows(WIRE_PROJECTS);
    expect(rows.map((row) => row.id)).toEqual([
      "3f8c1a54-0000-4000-8000-000000000002",
      "3f8c1a54-0000-4000-8000-000000000001",
    ]);
  });

  it("does not carry the directory into the UI at all, in any field", async () => {
    // The stronger half: not just "id is the id", but "the directory never
    // reaches a renderable value", so no later edit can put it on screen as
    // an identifier a user might copy into a URL.
    const serialized = JSON.stringify(toProjectRows(WIRE_PROJECTS));
    expect(serialized).not.toContain("run-9b21e0d4-aaaa-4000-8000-000000000009");
    expect(serialized).not.toContain("run-77c3f1aa-bbbb-4000-8000-00000000000b");
  });

  it("puts the newest project first — the server orders oldest-first", async () => {
    // `listProjectsByOwner` is `ORDER BY created_at, directory`. The most
    // recently generated site is the one a tester wants, and after a
    // generation it would otherwise appear at the bottom of a growing list.
    expect(toProjectRows(WIRE_PROJECTS).map((row) => row.name)).toEqual([
      "a climbing-gym storefront",
      "a bakery landing page",
    ]);
  });

  it("labels the created date without depending on the machine's locale", async () => {
    expect(toProjectRows(WIRE_PROJECTS)[0]!.createdAtLabel).toBe("2026-08-09");
  });

  it("survives a malformed row rather than throwing inside render", async () => {
    // There is no error boundary above this screen (App.tsx says so for
    // `previewUrl`, for the same reason). `new Date(NaN).toISOString()`
    // THROWS, so an absent or non-numeric `created_at` from an
    // adopted/hand-inserted row would take the whole editor down.
    const rows = toProjectRows([
      { id: "p-1" },
      { id: "p-2", name: "", createdAt: "not a number" },
      { id: "p-3", name: 42, createdAt: Number.NaN },
    ]);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(typeof row.name).toBe("string");
      expect(row.name).not.toBe("");
      expect(typeof row.createdAtLabel).toBe("string");
    }
  });

  it("drops an entry with no usable id rather than rendering an unopenable row", async () => {
    expect(toProjectRows([{ name: "no id here" }, ...WIRE_PROJECTS])).toHaveLength(2);
  });

  it("answers an empty list for anything that is not an array", async () => {
    for (const payload of [undefined, null, {}, "projects", 7]) {
      expect(toProjectRows(payload)).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * loadProjects
 * ------------------------------------------------------------------ */

describe("loadProjects", () => {
  it("GETs /api/projects and shapes the `projects` array", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () => new Response(JSON.stringify({ projects: WIRE_PROJECTS }), { status: 200 }),
    );
    const rows = await loadProjects({ fetchImpl });
    expect(calls[0]!.url).toBe("/api/projects");
    expect(calls[0]!.method).toBe("GET");
    expect(rows.map((row) => row.name)).toEqual([
      "a climbing-gym storefront",
      "a bakery landing page",
    ]);
  });

  it("a 401 is an expired session, distinguishable from a load failure", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "not authenticated" }), { status: 401 });
    const error = await loadProjects({ fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionExpiredError);
  });

  it("any other failure is a plain error naming the STATUS, thrown BEFORE the body is parsed as a project list", async () => {
    // A 500's `{error: "..."}` parses as JSON perfectly well; reading it as
    // the resource is how `refreshManifest` once rendered `undefined.nodes`.
    //
    // The status, not the body: unlike `POST /api/generate` — which words
    // 402/429/400/413 itself, each with different advice — this endpoint has
    // no vocabulary worth quoting. Its realistic failure in this deployment
    // model is a 502 from the editor's own Vite proxy because the hosted
    // server is not running, where `{error: "internal"}` (or an HTML error
    // page) tells a tester nothing and the status tells them everything.
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "internal" }), { status: 500 });
    const error = await loadProjects({ fetchImpl }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).toContain("500");
  });
});

/* ------------------------------------------------------------------ *
 * The component half, asserted as source text
 * ------------------------------------------------------------------ */

describe("ProjectPicker.tsx: the component cannot render a directory", () => {
  it("never READS a project's directory — not as a property, not as a key", async () => {
    // `ProjectRow` deliberately has no `directory` field, so the JSX
    // structurally cannot show one. This is what stops that from being
    // "fixed" by reading the raw wire object in render instead. A picker
    // that showed the directory as the project's identity would send a
    // tester to `?project=<run-id>`, which 404s EXACTLY like a project that
    // does not exist — `requireProject` answers a foreign project and an
    // absent one identically, deliberately, so it is not an enumeration
    // oracle, which also means it cannot tell you that you used the wrong
    // UUID.
    //
    // Matched as CODE, not as prose. A blanket `/\bdirectory\b/` would ban
    // this module's own header comment, which is the thing explaining the
    // hazard — banning the explanation is how the explanation gets deleted.
    // Every way to actually reach the field is a property access
    // (`raw.directory`, `project.directory`, `row.directory`) or a quoted key
    // (`readString(raw, "directory")`, `raw["directory"]`), and both are
    // covered here.
    expect(pickerSource).not.toMatch(/\.directory\b/);
    expect(pickerSource).not.toMatch(/["']directory["']/);
  });

  it("opens a project with the row's id", async () => {
    expect(pickerSource).toContain("onOpen(row.id)");
  });

  it("states the cost, the duration and the absence of cancellation on the form that spends money", async () => {
    // ~$1.74 and ~11 minutes are measured figures, and there is NO
    // cancellation (spec decision 13: the subprocess cannot be safely
    // killed) — a mistyped brief spends anyway. A tester who is not told
    // this before pressing the button finds out by paying.
    expect(pickerSource).toContain("$1.74");
    expect(pickerSource).toMatch(/11 minutes/);
    // ...and the figures are actually rendered, not just declared. The
    // footnote sits inside the <form>, after the submit button's own
    // declaration, so it is on screen with the control it qualifies.
    const footnote = pickerSource.slice(pickerSource.indexOf("picker-footnote"));
    expect(footnote).toContain("{GENERATION_COST_USD}");
    expect(footnote).toContain("{GENERATION_MINUTES}");
    expect(footnote).toMatch(/cannot be cancelled|no cancellation|cannot be stopped/i);
    expect(pickerSource.indexOf("new-site-form")).toBeLessThan(
      pickerSource.indexOf("picker-footnote"),
    );
  });
});
