/** Canvas-addressing passthrough (contract section 5): rendered as data-node-id on the element's root. */
export interface NodeProps {
  nodeId?: string;
}

/** A link-shaped call to action. hrefs must exist in shell/routes.ts or be explicitly external (contract 4.3). */
export interface CtaLink {
  label: string;
  href: string;
}
