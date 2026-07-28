import { cx } from "../../../lib/cx";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface Feature {
  key: string;
  title: string;
  description: string;
  /** Export-compiled overrides (contract 5.5) — never hand-authored with real values. */
  className?: string;
  childClassNames?: Record<string, string>;
  hidden?: boolean;
  childHidden?: Record<string, boolean>;
}

export interface CapabilitiesProps {
  eyebrow: string;
  heading: string;
  description: string;
  features: Feature[];
}

export default function Capabilities({
  nodeId,
  eyebrow,
  heading,
  description,
  features,
}: CapabilitiesProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-16)">
      <Container>
        <div className="mx-auto flex max-w-[40rem] flex-col items-center gap-(--space-2) text-center">
          <Text nodeId="home.capabilities.eyebrow" variant="eyebrow">
            {eyebrow}
          </Text>
          <Heading nodeId="home.capabilities.heading" level={2} variant="section">
            {heading}
          </Heading>
          <Text nodeId="home.capabilities.description" variant="lead">
            {description}
          </Text>
        </div>

        <div data-node-id="home.capabilities.grid" className="mt-(--space-12) grid grid-cols-3 items-start gap-(--space-6)">
          {features.map((feature) => {
            if (feature.hidden === true) return null;
            const featureId = `${nodeId}.feature-${feature.key}`;
            return (
              <div
                key={feature.key}
                data-node-id={featureId}
                className={cx(
                  "rounded-(--radius-md) border border-solid border-(--color-semantic-border)",
                  "bg-(--color-semantic-surface) p-(--space-6)",
                  feature.className,
                )}
              >
                {feature.childHidden?.title !== true && (
                  <Heading
                    nodeId={`${featureId}.title`}
                    level={3}
                    variant="subsection"
                    className={feature.childClassNames?.title}
                  >
                    {feature.title}
                  </Heading>
                )}
                {feature.childHidden?.description !== true && (
                  <Text
                    nodeId={`${featureId}.description`}
                    variant="body"
                    className={cx("mt-(--space-2)", feature.childClassNames?.description)}
                  >
                    {feature.description}
                  </Text>
                )}
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}
