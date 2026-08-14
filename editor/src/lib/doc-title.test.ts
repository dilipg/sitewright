import { describe, expect, it } from "vitest";
import { APP_TITLE, documentTitleFor, type EditorScreen } from "./doc-title";

/**
 * DOGFOOD G8: the tab read "Editor" on every screen, so two tabs of this app —
 * one watching an eleven-minute paid run, one reading the docs — were
 * indistinguishable.
 */

const ALL_SCREENS: readonly EditorScreen[] = [
  "login",
  "checking",
  "picker",
  "key",
  "generating",
  "unopenable",
  "plan",
  "canvas",
];

describe("documentTitleFor", () => {
  it("gives every screen a DIFFERENT title, which is the whole point", () => {
    const titles = ALL_SCREENS.map((screen) => documentTitleFor(screen, "532b215c-1962-4996-8411-f4e722fbf6ab"));
    expect(new Set(titles).size).toBe(ALL_SCREENS.length);
    for (const title of titles) expect(title.trim()).not.toBe("");
  });

  it("ends every title with the product name, so a truncated tab still shows the distinguishing half first", () => {
    for (const screen of ALL_SCREENS) {
      expect(documentTitleFor(screen, "532b215c-abcd")).toMatch(new RegExp(`${APP_TITLE}$`));
    }
  });

  it("names the run on the screen a tester leaves open for eleven minutes", () => {
    expect(documentTitleFor("generating")).toBe("Generating your site · Website Generator");
  });

  it("names the project by its id PREFIX on the canvas, which is what the URL shows", () => {
    // The canvas never loads `GET /api/projects`, so the human name the picker
    // shows is not in hand there; the id is, on the URL. Eight characters is
    // what identifies a project everywhere else in this codebase.
    expect(documentTitleFor("canvas", "532b215c-1962-4996-8411-f4e722fbf6ab")).toBe(
      "Editing 532b215c · Website Generator",
    );
  });

  it("never renders 'Editing undefined' for a canvas with no project (local mode)", () => {
    // Local mode reaches the canvas with no project at all. It never calls this
    // (App's effect returns early), but a title function that produced
    // "Editing undefined" for the one call shape it will meet if that guard is
    // ever loosened is a trap left lying around.
    expect(documentTitleFor("canvas")).toBe(APP_TITLE);
    expect(documentTitleFor("canvas", "")).toBe(APP_TITLE);
    expect(documentTitleFor("canvas")).not.toMatch(/undefined/);
  });

  it("does not leave the old title in place for any screen", () => {
    // The absence half: "Editor" was the title on every screen, and a mapping
    // that still produced it somewhere would reproduce the finding.
    for (const screen of ALL_SCREENS) {
      expect(documentTitleFor(screen, "p1")).not.toBe("Editor");
    }
  });
});
