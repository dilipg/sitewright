import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

/** A second section on the "about" route, which exists so the route has two
 * sections to REORDER (PRD 3.3). "home" already has six, but every one of them
 * also carries a visibility case, and a ghosted node keeps its layout space in
 * preview while the export compiles it out (contract 6.2) — so every node
 * below one sits at a different absolute Y on the two sides, and moving a
 * section there shifts unrelated screenshots onto different pixel boundaries.
 *
 * This route carries no visibility case, so both sections render at identical
 * positions in preview and export and a reorder perturbs nothing. It also puts
 * the page's FailedSectionPlaceholder between two reorderable sections, which
 * is the only end-to-end coverage of the rule that a child with no node id
 * holds its slot instead of being shuffled or dropped. */
export interface AboutValuesProps {
  heading: string;
  body: string;
}

export default function AboutValues({ nodeId, heading, body }: AboutValuesProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-surface) py-(--space-24)">
      <Container>
        <div className="mx-auto flex max-w-[48rem] flex-col gap-(--space-4)">
          <Heading nodeId="about.values.heading" level={2} variant="section">
            {heading}
          </Heading>
          <Text nodeId="about.values.body" variant="body">
            {body}
          </Text>
        </div>
      </Container>
    </section>
  );
}
