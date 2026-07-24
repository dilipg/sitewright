import { cx } from "../../../lib/cx";
import Button from "../../../primitives/Button";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { CtaLink, NodeProps } from "../../../lib/types";

export interface HeroProps {
  eyebrow: string;
  headline: string;
  subheadline: string;
  ctaPrimary: CtaLink;
  ctaSecondary: CtaLink;
}

export default function Hero({
  nodeId,
  eyebrow,
  headline,
  subheadline,
  ctaPrimary,
  ctaSecondary,
}: HeroProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-24)">
      <Container>
        <div className={cx("mx-auto flex max-w-[48rem] flex-col items-center", "gap-(--space-6) text-center")}>
          <Text nodeId="home.hero.eyebrow" variant="eyebrow">
            {eyebrow}
          </Text>
          <Heading nodeId="home.hero.headline" level={1} variant="display">
            {headline}
          </Heading>
          <Text nodeId="home.hero.subheadline" variant="lead">
            {subheadline}
          </Text>
          <div className="mt-(--space-2) flex gap-(--space-4)">
            <Button nodeId="home.hero.cta-primary" variant="primary" href={ctaPrimary.href}>
              {ctaPrimary.label}
            </Button>
            <Button nodeId="home.hero.cta-secondary" variant="secondary" href={ctaSecondary.href}>
              {ctaSecondary.label}
            </Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
