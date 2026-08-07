import { describe, expect, it, vi } from "vitest";
import { enqueueAndPoll, formatElapsedSeconds } from "./jobs";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("enqueueAndPoll: the local/unauthenticated preview server (compiler/scripts/preview.ts)", () => {
  it("resolves immediately as 'succeeded' from a synchronous 200, with no polling at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { passed: true, orphanedOverrides: [] }));
    const outcome = await enqueueAndPoll("http://localhost:5273/__regen", { section: "home.hero" }, { fetchImpl });

    expect(outcome).toEqual({ status: "succeeded", result: { passed: true, orphanedOverrides: [] } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts the body as JSON with the right method and content-type", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await enqueueAndPoll("http://localhost:5273/__edit-prompt", { route: "home", instruction: "x" }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:5273/__edit-prompt",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route: "home", instruction: "x" }),
      }),
    );
  });

  it("treats a non-202 REFUSAL (e.g. a hosted-server 402 over the spend cap) the same way -- the body is the outcome, not an error to throw here", async () => {
    // enqueueAndPoll itself never inspects `.error`; it hands the parsed
    // body back verbatim so the CALLER's existing `outcome.error !==
    // undefined` check keeps working unchanged.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(402, { error: "spend cap reached" }));
    const outcome = await enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl });

    expect(outcome).toEqual({ status: "succeeded", result: { error: "spend cap reached" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a gate failure is still a 'succeeded' outcome -- passed:false lives inside result, not in the status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { passed: false, failureReport: "gate 3 failed" }));
    const outcome = await enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl });

    expect(outcome.status).toBe("succeeded");
    expect((outcome.result as { passed: boolean }).passed).toBe(false);
    expect((outcome.result as { failureReport: string }).failureReport).toBe("gate 3 failed");
  });
});

describe("enqueueAndPoll: the hosted server (202 + job polling)", () => {
  function fakeClock() {
    let elapsed = 0;
    return {
      now: () => elapsed,
      wait: async (ms: number) => {
        elapsed += ms;
      },
    };
  }

  it("enqueues, polls until a terminal status, and resolves with the job's own result", async () => {
    const { now, wait } = fakeClock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "queued" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "running" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "succeeded", result: { passed: true } }));

    const onStatus = vi.fn();
    const outcome = await enqueueAndPoll(
      "http://localhost:5273/__regen",
      { section: "home.hero" },
      { fetchImpl, onStatus, now, wait, pollIntervalMs: 2000 },
    );

    expect(outcome).toEqual({ status: "succeeded", result: { passed: true }, error: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenNthCalledWith(1, { status: "queued", elapsedMs: 0 });
    expect(onStatus).toHaveBeenNthCalledWith(2, { status: "running", elapsedMs: 2000 });
  });

  it("derives the poll URL from the ENQUEUE url's own origin, regardless of the enqueue path or query string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "abc-123" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "succeeded", result: {} }));

    await enqueueAndPoll(
      "http://localhost:5273/__regen-page?project=xyz",
      {},
      { fetchImpl, wait: async () => {} },
    );

    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://localhost:5273/api/jobs/abc-123");
  });

  it("resolves 'failed' with the redacted error message -- a request-level failure, distinct from a gate failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-2" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "failed", error: "could not start the preview" }));

    const outcome = await enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} });

    expect(outcome).toEqual({ status: "failed", result: undefined, error: "could not start the preview" });
  });

  it("resolves 'interrupted' distinctly -- it is not reported as 'failed' and carries no error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-3" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "interrupted" }));

    const outcome = await enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} });

    expect(outcome.status).toBe("interrupted");
    expect(outcome.status).not.toBe("failed");
    expect(outcome.error).toBeUndefined();
  });

  it("polls at the configured interval, not on every microtask", async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-4" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "running" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "succeeded", result: {} }));

    await enqueueAndPoll(
      "http://localhost:5273/__regen",
      {},
      {
        fetchImpl,
        pollIntervalMs: 2000,
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );

    expect(waits).toEqual([2000]);
  });

  it("rejects rather than fabricating a terminal outcome when a mid-flight poll answers 404 (the job row is gone or foreign)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-5" }))
      .mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));

    await expect(
      enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} }),
    ).rejects.toThrow(/404/);
  });

  it("the ok-check is independently load-bearing: an ERROR STATUS whose body happens to still look like a valid job (contrived, but isolates the check) is still rejected, not returned as terminal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-5b" }))
      // A body that would pass the status-shape check on its own -- the ONLY
      // thing that can catch this is checking jobResponse.ok itself.
      .mockResolvedValueOnce(jsonResponse(404, { status: "succeeded", result: { passed: true } }));

    await expect(
      enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} }),
    ).rejects.toThrow(/404/);
  });

  it("rejects rather than fabricating a terminal outcome when a mid-flight poll answers 401 (a session expiring mid-run)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-6" }))
      .mockResolvedValueOnce(jsonResponse(401, { error: "not authenticated" }));

    await expect(
      enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} }),
    ).rejects.toThrow(/401/);
  });

  it("rejects rather than treating a 200 with no recognised status as terminal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-7" }))
      .mockResolvedValueOnce(jsonResponse(200, { error: "not found" })); // no `status` field at all

    await expect(
      enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} }),
    ).rejects.toThrow(/unrecognised status/);
  });

  it("rejects a 200 carrying a status this build does not know about, rather than returning it as terminal", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-8" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "cancelled" }));

    await expect(
      enqueueAndPoll("http://localhost:5273/__regen", {}, { fetchImpl, wait: async () => {} }),
    ).rejects.toThrow(/unrecognised status/);
  });

  it("still polls normally through several non-terminal statuses once the response shape is valid (the fix doesn't break the happy path)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { jobId: "job-9" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "queued" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "running" }))
      .mockResolvedValueOnce(jsonResponse(200, { status: "succeeded", result: { passed: true } }));

    const outcome = await enqueueAndPoll(
      "http://localhost:5273/__regen",
      {},
      { fetchImpl, wait: async () => {} },
    );

    expect(outcome).toEqual({ status: "succeeded", result: { passed: true }, error: undefined });
  });
});

describe("formatElapsedSeconds", () => {
  it("floors to whole seconds rather than rounding", () => {
    expect(formatElapsedSeconds(0)).toBe("0s");
    expect(formatElapsedSeconds(999)).toBe("0s");
    expect(formatElapsedSeconds(1000)).toBe("1s");
    expect(formatElapsedSeconds(61_234)).toBe("61s");
  });

  it("never shows a negative count", () => {
    expect(formatElapsedSeconds(-500)).toBe("0s");
  });
});
