import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Manifest, ManifestEntryProposal } from "./manifest";
import { commit, createManifest, propose, tombstone } from "./manifest";

const fixtureManifestPath = fileURLToPath(
  new URL("../../fixtures/acme-landing/manifest.json", import.meta.url),
);

function fixtureManifest(): Manifest {
  return JSON.parse(readFileSync(fixtureManifestPath, "utf8")) as Manifest;
}

/** Rebuilds the fixture's manifest entries as agent-style proposals. */
function fixtureProposals(): ManifestEntryProposal[] {
  return Object.entries(fixtureManifest().nodes).map(([nodeId, node]) => ({
    nodeId,
    route: node.route,
    file: node.file,
    component: node.component,
    element: node.element,
    editable: node.editable,
  }));
}

const homePageConfig = {
  owner: "page:home",
  ownershipMap: { "page:home": ["src/pages/home/"] },
};

describe("manifest service: round-trip against the fixture", () => {
  it("accepts the fixture's own entries as a valid proposal", () => {
    const result = propose(createManifest(), fixtureProposals(), homePageConfig);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("commit reproduces the fixture manifest exactly", () => {
    const committed = commit(createManifest(), fixtureProposals(), homePageConfig);
    expect(committed).toEqual(fixtureManifest());
  });

  it("commit does not mutate the input manifest", () => {
    const empty = createManifest();
    commit(empty, fixtureProposals(), homePageConfig);
    expect(empty.nodes).toEqual({});
  });
});

describe("manifest service: ID format", () => {
  function proposeSingle(nodeId: string) {
    return propose(
      createManifest(),
      [{ ...fixtureProposals()[0]!, nodeId }],
      homePageConfig,
    );
  }

  it("accepts section-root IDs with two segments (route.section)", () => {
    expect(proposeSingle("home.hero").valid).toBe(true);
  });

  it("accepts deep element paths (route.section.group.element)", () => {
    expect(proposeSingle("home.pricing.tier-1.cta").valid).toBe(true);
  });

  it("accepts data-derived indexed slugs like tier-1 (contract 5.2's own example)", () => {
    expect(proposeSingle("home.tiers.tier-1").valid).toBe(true);
  });

  it("rejects positional-looking IDs like child-3", () => {
    const result = proposeSingle("home.hero.child-3");
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("id-format");
    expect(result.issues[0]?.message).toContain("child-3");
    expect(result.issues[0]?.message).toContain("semantic");
  });

  it("rejects IDs with fewer than two segments", () => {
    const result = proposeSingle("hero");
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("id-format");
  });

  it("rejects uppercase and non-slug segments", () => {
    expect(proposeSingle("home.Hero.headline").valid).toBe(false);
    expect(proposeSingle("home.hero.head_line").valid).toBe(false);
    expect(proposeSingle("home..headline").valid).toBe(false);
  });
});

describe("manifest service: uniqueness", () => {
  it("rejects a proposal whose ID is already registered and active", () => {
    const manifest = commit(createManifest(), fixtureProposals(), homePageConfig);
    const result = propose(manifest, [fixtureProposals()[0]!], homePageConfig);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("duplicate-id");
    expect(result.issues[0]?.message).toContain("immutable");
  });

  it("rejects duplicate IDs within one proposal batch", () => {
    const entry = fixtureProposals()[0]!;
    const result = propose(createManifest(), [entry, { ...entry }], homePageConfig);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("duplicate-id");
  });
});

describe("manifest service: ownership boundary", () => {
  it("rejects a file outside the proposing agent's boundary", () => {
    const entry = { ...fixtureProposals()[0]!, file: "src/shell/Nav.tsx" };
    const result = propose(createManifest(), [entry], homePageConfig);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("ownership");
    expect(result.issues[0]?.message).toContain("src/shell/Nav.tsx");
    expect(result.issues[0]?.message).toContain("page:home");
  });

  it("rejects proposals from an owner missing from the ownership map", () => {
    const result = propose(createManifest(), [fixtureProposals()[0]!], {
      owner: "page:pricing",
      ownershipMap: { "page:home": ["src/pages/home/"] },
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("ownership");
  });
});

describe("manifest service: editable channels", () => {
  it("rejects channel values outside the closed set (docs/decisions.md)", () => {
    const entry = { ...fixtureProposals()[0]!, editable: ["text", "color"] };
    const result = propose(createManifest(), [entry], homePageConfig);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("editable-channel");
    expect(result.issues[0]?.message).toContain('"color"');
    expect(result.issues[0]?.message).toContain("text, style, layout, visibility");
  });
});

describe("manifest service: tombstones", () => {
  function tombstonedManifest(): Manifest {
    const manifest = commit(createManifest(), fixtureProposals(), homePageConfig);
    return tombstone(manifest, ["home.hero.subheadline"]);
  }

  it("tombstone marks nodes tombstoned without mutating the input", () => {
    const manifest = commit(createManifest(), fixtureProposals(), homePageConfig);
    const next = tombstone(manifest, ["home.hero.subheadline"]);
    expect(next.nodes["home.hero.subheadline"]?.status).toBe("tombstoned");
    expect(manifest.nodes["home.hero.subheadline"]?.status).toBe("active");
  });

  it("throws on tombstoning an unknown node ID", () => {
    expect(() => tombstone(createManifest(), ["home.hero"])).toThrow(
      'Cannot tombstone unknown node ID "home.hero"',
    );
  });

  it("rejects resurrection with a different file/component", () => {
    const entry = fixtureProposals().find((p) => p.nodeId === "home.hero.subheadline")!;
    const moved = { ...entry, file: "src/pages/home/sections/Intro.tsx", component: "Intro" };
    const result = propose(tombstonedManifest(), [moved], homePageConfig);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.rule).toBe("tombstone-resurrection");
    expect(result.issues[0]?.message).toContain("home.hero.subheadline");
  });

  it("allows re-registration of a tombstoned ID with the same file and component", () => {
    const entry = fixtureProposals().find((p) => p.nodeId === "home.hero.subheadline")!;
    const result = propose(tombstonedManifest(), [entry], homePageConfig);
    expect(result.valid).toBe(true);
    const committed = commit(tombstonedManifest(), [entry], homePageConfig);
    expect(committed.nodes["home.hero.subheadline"]?.status).toBe("active");
  });
});

describe("manifest service: commit safety", () => {
  it("commit throws when proposals are invalid, leaving no partial state", () => {
    const bad = { ...fixtureProposals()[0]!, nodeId: "home.hero.child-3" };
    expect(() => commit(createManifest(), [bad], homePageConfig)).toThrow(
      /Cannot commit invalid proposals/,
    );
  });
});
