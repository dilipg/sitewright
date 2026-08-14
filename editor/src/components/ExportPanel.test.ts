import { describe, expect, it } from "vitest";
import type { ExportFailure, GateResult } from "./ExportPanel";
import {
  affectedRoutesOf,
  BLOCKED_EXPLANATION,
  BLOCKED_TITLE,
  BLOCKED_VERDICT,
  buildFileTree,
  classifyExportFailure,
  describeBlockedRemedy,
  REGENERATE_PAGE_BUTTON_LABEL,
  summariseFailureMessage,
} from "./ExportPanel";
// Vite's own `?raw` — the precedent `App.test.ts` and `GenerationProgress.test.ts`
// set for a component this workspace cannot mount (no React testing library, and
// none may be added).
import panelSource from "./ExportPanel.tsx?raw";
import appSourceForExport from "../App.tsx?raw";

/** Flattens the tree back to "dir/" + "file" labels, depth-first, for assertion. */
function flatten(node: ReturnType<typeof buildFileTree>, prefix = ""): string[] {
  const out: string[] = [];
  for (const child of node.children.values()) {
    const label = `${prefix}${child.name}`;
    out.push(child.isFile ? label : `${label}/`);
    if (!child.isFile) out.push(...flatten(child, `${label}/`));
  }
  return out;
}

describe("buildFileTree", () => {
  it("nests files under their directories", () => {
    const tree = buildFileTree(["HANDOVER.md", "src/pages/home/index.tsx", "src/shell/routes.ts"]);
    expect(flatten(tree)).toEqual([
      "HANDOVER.md",
      "src/",
      "src/pages/",
      "src/pages/home/",
      "src/pages/home/index.tsx",
      "src/shell/",
      "src/shell/routes.ts",
    ]);
  });

  it("shares a directory node across siblings rather than duplicating it", () => {
    const tree = buildFileTree(["src/a.ts", "src/b.ts"]);
    expect(tree.children.size).toBe(1);
    expect(tree.children.get("src")!.children.size).toBe(2);
  });

  it("marks only leaves as files", () => {
    const tree = buildFileTree(["src/pages/home/index.tsx"]);
    expect(tree.children.get("src")!.isFile).toBe(false);
    expect(
      tree.children.get("src")!.children.get("pages")!.children.get("home")!.children.get("index.tsx")!
        .isFile,
    ).toBe(true);
  });

  it("handles an empty package", () => {
    expect(buildFileTree([]).children.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * DOGFOOD G3 — a wrecked run must not look like a retryable one
 * ------------------------------------------------------------------ */

/** The real shape gate 4 produced on the dogfood run: `ContactHero.tsx` is on
 *  disk, its node ids never reached `manifest.json` because the section's
 *  `commit_section_manifest` step died, and the export can therefore never
 *  succeed. Five failures, all in one file — the "and 4 more" the tester saw. */
function lostManifestEntries(): GateResult[] {
  return [
    {
      gate: 4,
      name: "node-ids-registered",
      passed: false,
      failures: ["eyebrow", "headline", "subheadline", "cta-primary", "cta-secondary"].map(
        (leaf, index) => ({
          gate: 4,
          reason: "unregistered-node-id",
          file: "src/pages/contact/sections/ContactHero.tsx",
          line: 28 + index,
          message: `Element at src/pages/contact/sections/ContactHero.tsx:${String(28 + index)} carries data-node-id "contact.contact-hero.${leaf}", which is not an active node in manifest.json. Propose a manifest entry for it or remove the attribute (contract 5.4).`,
        }),
      ),
    },
  ];
}

function failureWithGates(gates: GateResult[], message = "Export failed validation gates:\n- one\n- two"): ExportFailure {
  return { ok: false, message, gateReport: { passed: false, gates } };
}

describe("classifyExportFailure: which failures can honestly offer a retry", () => {
  it("refuses a retry for a manifest/source mismatch, because no retry can ever fix it", () => {
    // The finding: the ONLY button offered was "Try export again", which would
    // fail identically forever. Nothing in this editor writes generated source
    // or the manifest, and the exporter is deterministic.
    expect(classifyExportFailure(failureWithGates(lostManifestEntries())).kind).toBe("blocked");
  });

  it("covers all four of gate 4's node-registry reasons, not just the one that was observed", () => {
    for (const reason of [
      "missing-manifest",
      "unregistered-node-id",
      "missing-node-id",
      "duplicate-node-id",
    ]) {
      const gates: GateResult[] = [
        { gate: 4, name: "node-ids-registered", passed: false, failures: [{ gate: 4, reason, message: "x" }] },
      ];
      expect(classifyExportFailure(failureWithGates(gates)).kind, reason).toBe("blocked");
    }
  });

  it("KEEPS the retry for a failure with no gate report at all — the user can fix those", () => {
    // `export.spec.ts`'s own failing export: an override naming a token that
    // does not exist in tokens.css. The exporter throws before the gates run, so
    // there is no gate report — and the fix is one click away in the inspector,
    // so a retry is exactly right. Perturbing the classifier to blanket-refuse
    // every failure breaks this test AND that Playwright assertion.
    const outcome: ExportFailure = {
      ok: false,
      message: 'Override on "home.hero" references token "color.semantic.nonexistent", but no --color-semantic-nonexistent exists in tokens.css.',
    };
    expect(classifyExportFailure(outcome).kind).toBe("retryable");
  });

  it("keeps the retry for a gate failure an OVERRIDE can cause, rather than blanket-refusing every gate", () => {
    // Gates run AFTER the overrides are compiled in, so a gate 3 (tokens-only)
    // failure can be the user's own off-scale edit — repairable here, and a
    // retry after repairing it is honest.
    const gates: GateResult[] = [
      { gate: 3, name: "tokens-only", passed: false, failures: [{ gate: 3, reason: "raw-value", message: "x" }] },
    ];
    expect(classifyExportFailure(failureWithGates(gates)).kind).toBe("retryable");
  });

  it("names the routes a regeneration would have to rewrite", () => {
    const shape = classifyExportFailure(failureWithGates(lostManifestEntries()));
    expect(shape.kind === "blocked" ? shape.routes : []).toEqual(["contact"]);
  });

  it("de-duplicates routes and ignores failures that name no file", () => {
    const gates: GateResult[] = [
      {
        gate: 4,
        name: "node-ids-registered",
        passed: false,
        failures: [
          { gate: 4, reason: "unregistered-node-id", file: "src/pages/shop/sections/A.tsx", message: "a" },
          { gate: 4, reason: "unregistered-node-id", file: "src/pages/shop/sections/B.tsx", message: "b" },
          { gate: 4, reason: "missing-node-id", file: "src/pages/about/sections/C.tsx", message: "c" },
          // The whole registry is gone: no file to blame, and no route to name.
          { gate: 4, reason: "missing-manifest", message: "manifest.json not found" },
        ],
      },
    ];
    expect(affectedRoutesOf(gates)).toEqual(["shop", "about"]);
  });

  it("does not count a repairable failure's file as an affected route", () => {
    const gates: GateResult[] = [
      { gate: 5, name: "content-via-props", passed: false, failures: [{ gate: 5, reason: "hardcoded-string", file: "src/pages/home/sections/Hero.tsx", message: "x" }] },
    ];
    expect(affectedRoutesOf(gates)).toEqual([]);
  });
});

describe("the blocked state's wording", () => {
  it("says the site was generated but cannot be exported — not that the export failed", () => {
    // "Export failed — nothing was shipped" invites a retry. This is a
    // different fact: the site itself is not exportable.
    expect(BLOCKED_TITLE).toBe("This site was generated, but it cannot be exported");
  });

  it("says a retry cannot help, rather than leaving the missing button to imply it", () => {
    expect(BLOCKED_VERDICT).toMatch(/cannot change this/i);
    expect(BLOCKED_VERDICT).toMatch(/deterministic/i);
  });

  it("says the loss happened during generation, and that nothing the user edited is lost", () => {
    // A tester reading gate 4's own message concludes "the model wrote bad
    // code" (dogfood's own "things I knew that a tester would not", item 13).
    expect(BLOCKED_EXPLANATION).toMatch(/written during generation/i);
    expect(BLOCKED_EXPLANATION).toMatch(/nothing you edited is lost/i);
  });

  it("tells a page that CAN be regenerated from here apart from one that cannot", () => {
    // The dogfood case exactly: the lost section took its whole route out of the
    // manifest, so `contact` was absent from the canvas's tab strip while the
    // generated nav still linked to it. "Select a section on the contact page"
    // is then impossible advice — the same class of failure as telling a user to
    // click a placeholder that carries no node id (fixed in 07c23e2).
    const unreachable = describeBlockedRemedy(["contact"], ["home"]);
    expect(unreachable).toMatch(/contact is missing from this canvas entirely/);
    expect(unreachable).toMatch(/generate the site again from your brief/);
    expect(unreachable).not.toMatch(/Select a section/);

    const reachable = describeBlockedRemedy(["contact"], ["home", "contact"]);
    expect(reachable).toMatch(/Select a section on the affected page \(contact\)/);
    // And it quotes the button that actually exists.
    expect(reachable).toContain(REGENERATE_PAGE_BUTTON_LABEL);
    expect(REGENERATE_PAGE_BUTTON_LABEL).toBe("Regenerate whole page");
  });

  it("splits a mixed set, rather than picking one remedy for both", () => {
    const both = describeBlockedRemedy(["shop", "contact"], ["home", "shop"]);
    expect(both).toMatch(/Select a section on the affected page \(shop\)/);
    expect(both).toMatch(/contact is missing from this canvas entirely/);
  });

  it("states both remedies when the caller has no route table to judge by", () => {
    const unknown = describeBlockedRemedy(["contact"]);
    expect(unknown).toMatch(/Select a section on the affected page \(contact\)/);
    expect(unknown).toMatch(/generate the site again from your brief/);
  });

  it("still gives usable advice when no route can be named", () => {
    // `missing-manifest` names no file, so the route list is legitimately empty
    // and the advice must not degrade into "the affected pages ()".
    const noRoutes = describeBlockedRemedy([], ["home"]);
    expect(noRoutes).not.toContain("()");
    expect(noRoutes).toMatch(/generate the site again from your brief/);
  });

  it("pluralises the page noun rather than saying '1 pages'", () => {
    expect(describeBlockedRemedy(["contact"], ["contact"])).toContain("affected page (contact)");
    expect(describeBlockedRemedy(["contact", "shop"], ["contact", "shop"])).toContain(
      "affected pages (contact, shop)",
    );
  });
});

/* ------------------------------------------------------------------ *
 * DOGFOOD G8 — the same violations printed twice
 * ------------------------------------------------------------------ */

describe("summariseFailureMessage", () => {
  it("drops the bullet list when the structured gate report will render it", () => {
    // `exporter.ts` builds the message as a headline plus one `- <message>` line
    // per failure, and the gate report carries the same messages field by field.
    const message = "Export failed validation gates:\n- first violation\n- second violation";
    expect(summariseFailureMessage(message, true)).toBe("Export failed validation gates:");
  });

  it("keeps the whole message when there is no report — then it is the only diagnostic", () => {
    const message = 'Override on "home.hero" references token "color.semantic.nonexistent".';
    expect(summariseFailureMessage(message, false)).toBe(message);
  });

  it("keeps a message that is nothing BUT bullets, rather than rendering an empty paragraph", () => {
    expect(summariseFailureMessage("- only this", true)).toBe("- only this");
  });

  it("does not eat a dash that is mid-sentence", () => {
    const message = "Export failed — nothing was shipped\n- a violation";
    expect(summariseFailureMessage(message, true)).toBe("Export failed — nothing was shipped");
  });
});

describe("ExportPanel.tsx: the wiring a library test structurally cannot reach", () => {
  it("renders NO retry button in the blocked state", () => {
    // The behavioural half of G3. Perturbation: remove the `!blocked &&` guard
    // and this fails.
    expect(panelSource).toContain("{!blocked && (");
    const retryAt = panelSource.indexOf('data-testid="export-retry"');
    expect(retryAt).toBeGreaterThan(-1);
    expect(panelSource.lastIndexOf("{!blocked && (", retryAt)).toBeGreaterThan(-1);
  });

  it("classifies rather than guessing, and renders the blocked wording from the constants", () => {
    expect(panelSource).toContain("classifyExportFailure(outcome)");
    expect(panelSource).toContain("{BLOCKED_TITLE}");
    expect(panelSource).toContain("{BLOCKED_VERDICT}");
    expect(panelSource).toContain("describeBlockedRemedy(shape.routes, canvasRoutes)");
  });

  it("is told which routes the canvas has, so its advice can be reachable-aware", () => {
    // Perturbation: drop the prop from App and the blocked panel goes back to
    // offering advice it cannot know is possible.
    expect(appSourceForExport).toContain("canvasRoutes={routes.map((route) => route.slug)}");
  });

  it("passes the message through the de-duplicator instead of printing it raw", () => {
    expect(panelSource).toContain("summariseFailureMessage(outcome.message, failedGates.length > 0)");
    // The absence half: the old raw render would silently reinstate the
    // duplication.
    expect(panelSource).not.toContain(">{outcome.message}<");
  });
});
