import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Image from "../../../primitives/Image";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface AboutIntroProps {
  heading: string;
  body: string;
  portraitSrc: string;
  portraitAlt: string;
}

export default function AboutIntro({
  nodeId,
  heading,
  body,
  portraitSrc,
  portraitAlt,
}: AboutIntroProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-24)">
      <Container>
        <div className="mx-auto flex max-w-[48rem] flex-col gap-(--space-4)">
          <Heading nodeId="about.intro.heading" level={1} variant="display">
            {heading}
          </Heading>
          <Text nodeId="about.intro.body" variant="lead">
            {body}
          </Text>
          <Image nodeId="about.intro.portrait" src={portraitSrc} alt={portraitAlt} />
        </div>
      </Container>
    </section>
  );
}
