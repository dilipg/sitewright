import { cx } from "../../../lib/cx";
import Button from "../../../primitives/Button";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface Tier {
  key: string;
  name: string;
  price: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  badgeLabel?: string;
  /** Export-compiled overrides (contract 5.5) — never hand-authored with real values. */
  className?: string;
  childClassNames?: Record<string, string>;
  hidden?: boolean;
  childHidden?: Record<string, boolean>;
}

export interface PricingProps {
  heading: string;
  description: string;
  tiers: Tier[];
}

export default function Pricing({ nodeId, heading, description, tiers }: PricingProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-16)">
      <Container>
        <div className="mx-auto flex max-w-[40rem] flex-col items-center gap-(--space-2) text-center">
          <Heading nodeId="home.pricing.heading" level={2} variant="section">
            {heading}
          </Heading>
          <Text nodeId="home.pricing.description" variant="lead">
            {description}
          </Text>
        </div>

        <div data-node-id="home.pricing.grid" className="mt-(--space-12) grid grid-cols-3 items-start gap-(--space-6)">
          {tiers.map((tier) => {
            if (tier.hidden === true) return null;
            const tierId = `${nodeId}.tier-${tier.key}`;
            return (
              <div
                key={tier.key}
                data-node-id={tierId}
                className={cx(
                  "flex flex-col gap-(--space-4) rounded-(--radius-md) border border-solid",
                  "border-(--color-semantic-border) bg-(--color-semantic-surface) p-(--space-6)",
                  tier.className,
                )}
              >
                {tier.badgeLabel !== undefined && tier.childHidden?.badge !== true && (
                  <Text nodeId={`${tierId}.badge`} variant="eyebrow" className={tier.childClassNames?.badge}>
                    {tier.badgeLabel}
                  </Text>
                )}
                {tier.childHidden?.name !== true && (
                  <Heading nodeId={`${tierId}.name`} level={3} variant="subsection" className={tier.childClassNames?.name}>
                    {tier.name}
                  </Heading>
                )}
                {tier.childHidden?.price !== true && (
                  <Text nodeId={`${tierId}.price`} variant="lead" className={tier.childClassNames?.price}>
                    {tier.price}
                  </Text>
                )}
                {tier.childHidden?.description !== true && (
                  <Text nodeId={`${tierId}.description`} variant="body" className={tier.childClassNames?.description}>
                    {tier.description}
                  </Text>
                )}
                {tier.childHidden?.cta !== true && (
                  <Button
                    nodeId={`${tierId}.cta`}
                    variant="secondary"
                    href={tier.ctaHref}
                    className={cx("mt-auto", tier.childClassNames?.cta)}
                  >
                    {tier.ctaLabel}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
