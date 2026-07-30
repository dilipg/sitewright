import { describe, expect, it } from "vitest";
import { buildFileTree } from "./ExportPanel";

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
