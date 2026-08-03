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

export interface EditAgentResult {
  operations: EditOperation[];
  clarify?: string;
  structural?: { kind: string; route: string; archetype?: string; reason: string };
  notes: string;
}
