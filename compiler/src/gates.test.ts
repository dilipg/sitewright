import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GateReport } from "./gates";
import { runGates } from "./gates";

const fixturesDir = fileURLToPath(new URL("../../fixtures/", import.meta.url));
const cleanFixture = `${fixturesDir}acme-landing`;
const broken = (name: string) => `${fixturesDir}broken/${name}`;

function failedGates(report: GateReport): number[] {
  return report.gates.filter((g) => !g.passed).map((g) => g.gate);
}

function failuresOf(report: GateReport, gate: number) {
  return report.gates.find((g) => g.gate === gate)?.failures ?? [];
}

describe("runGates: clean fixture", () => {
  it("passes all six gates on fixtures/acme-landing", () => {
    const report = runGates(cleanFixture);
    expect(failedGates(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.gates).toHaveLength(6);
  });
});

describe("runGates: each broken variant fails exactly its gate", () => {
  it("gate 1: unresolvable import", () => {
    const report = runGates(broken("gate1-unresolved-import"));
    expect(failedGates(report)).toEqual([1]);
    const failure = failuresOf(report, 1)[0]!;
    expect(failure.reason).toBe("unresolved-import");
    expect(failure.message).toContain("./format");
    expect(failure.file).toContain("Hero.tsx");
  });

  it("gate 2: dangling href", () => {
    const report = runGates(broken("gate2-dangling-href"));
    expect(failedGates(report)).toEqual([2]);
    const failure = failuresOf(report, 2)[0]!;
    expect(failure.reason).toBe("dangling-href");
    expect(failure.message).toContain("/pricing");
    expect(failure.message).toContain("routes.ts");
  });

  it("gate 3: raw hex and raw px in a section", () => {
    const report = runGates(broken("gate3-raw-hex"));
    expect(failedGates(report)).toEqual([3]);
    const reasons = failuresOf(report, 3).map((f) => f.reason);
    expect(reasons).toContain("raw-hex");
    expect(reasons).toContain("raw-px");
    expect(failuresOf(report, 3)[0]?.message).toContain("token");
  });

  it("gate 4: manifest node never attached to an element", () => {
    const report = runGates(broken("gate4-missing-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("missing-node-id");
    expect(failure.message).toContain("home.hero.headline");
  });

  it("gate 4: duplicate data-node-id", () => {
    const report = runGates(broken("gate4-duplicate-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("duplicate-node-id");
    expect(failure.message).toContain("home.hero.headline");
  });

  it("gate 4: element carries an ID missing from the manifest", () => {
    const report = runGates(broken("gate4-unregistered-node-id"));
    expect(failedGates(report)).toEqual([4]);
    const failure = failuresOf(report, 4)[0]!;
    expect(failure.reason).toBe("unregistered-node-id");
    expect(failure.message).toContain("home.hero.badge");
  });

  it("gate 5: hardcoded user-visible string in section JSX", () => {
    const report = runGates(broken("gate5-hardcoded-string"));
    expect(failedGates(report)).toEqual([5]);
    const failure = failuresOf(report, 5)[0]!;
    expect(failure.reason).toBe("hardcoded-string");
    expect(failure.message).toContain("Welcome to Acme");
    expect(failure.message).toContain("props");
  });

  it("gate 6: cross-page import", () => {
    const report = runGates(broken("gate6-cross-page-import"));
    expect(failedGates(report)).toEqual([6]);
    const failure = failuresOf(report, 6)[0]!;
    expect(failure.reason).toBe("cross-page-import");
    expect(failure.message).toContain("pricing");
    expect(failure.file).toContain("index.tsx");
  });
});

describe("runGates: ownership boundary via written-files log", () => {
  it("flags files written outside the owner's boundary", () => {
    const report = runGates(cleanFixture, {
      ownershipMap: { "page:home": ["src/pages/home/"] },
      writtenFiles: { "page:home": ["src/pages/home/index.tsx", "src/shell/Nav.tsx"] },
    });
    expect(failedGates(report)).toEqual([6]);
    const failure = failuresOf(report, 6)[0]!;
    expect(failure.reason).toBe("out-of-boundary-write");
    expect(failure.message).toContain("src/shell/Nav.tsx");
    expect(failure.message).toContain("page:home");
  });

  it("passes when written files stay inside the boundary", () => {
    const report = runGates(cleanFixture, {
      ownershipMap: { "page:home": ["src/pages/home/"] },
      writtenFiles: { "page:home": ["src/pages/home/index.tsx"] },
    });
    expect(report.passed).toBe(true);
  });
});

describe("runGates: report structure", () => {
  it("reports all six gates with ids and names regardless of outcome", () => {
    const report = runGates(broken("gate3-raw-hex"));
    expect(report.gates.map((g) => g.gate)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const gate of report.gates) {
      expect(gate.name).toBeTruthy();
      expect(typeof gate.passed).toBe("boolean");
    }
  });
});
