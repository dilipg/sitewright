/** The wire contract between the edit agent, the preview server and the editor. */

export interface EditOperation {
  op: "text" | "style" | "styleExact" | "layout" | "visibility" | "sectionOrder";
  nodeId?: string;
  route?: string;
  value?: string;
  property?: string;
  token?: string;
  hidden?: boolean;
  order?: string[];
  key?: string;
}

/**
 * The agent's reply, as it ARRIVES — not as any one producer happens to write it.
 *
 * `| null` on the optional fields is load-bearing, not defensive. The Python
 * agent's `_normalize` emits an explicit `None` for an absent `clarify` /
 * `structural`, which reaches the editor as JSON `null`; the TypeScript mock
 * used to omit the same keys, so they arrived `undefined`. This file previously
 * declared only the `undefined` case, and an editor check of `!== undefined`
 * therefore matched `null`, took the structural branch, and threw on every real
 * prompt while the whole suite stayed green against the mock.
 *
 * Both spellings mean absent. Read this shape through
 * `editor/src/lib/edit-ops.ts`'s `interpretEditResult`, which is the one place
 * that decides which branch a reply means.
 */
export interface EditAgentResult {
  operations?: EditOperation[] | null;
  clarify?: string | null;
  structural?: { kind: string; route: string; archetype?: string; reason: string } | null;
  notes?: string | null;
}
