import Button from "../../../primitives/Button";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { CtaLink, NodeProps } from "../../../lib/types";

export interface CtaBandProps {
  heading: string;
  subheading: string;
  cta: CtaLink;
}

export default function CtaBand({ nodeId, heading, subheading, cta }: CtaBandProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-surface) py-(--space-16)">
      <Container>
        <div className="mx-auto flex max-w-[36rem] flex-col items-center gap-(--space-4) text-center">
          <Heading nodeId="home.cta-band.heading" level={2} variant="section">
            {heading}
          </Heading>
          <Text nodeId="home.cta-band.subheading" variant="lead">
            {subheading}
          </Text>
          <Button nodeId="home.cta-band.cta" variant="primary" href={cta.href} className="mt-(--space-2)">
            {cta.label}
          </Button>
        </div>
      </Container>
    </section>
  );
}
