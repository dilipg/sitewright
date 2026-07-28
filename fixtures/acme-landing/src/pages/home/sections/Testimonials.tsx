import { cx } from "../../../lib/cx";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface Testimonial {
  key: string;
  quote: string;
  attribution: string;
  /** Export-compiled overrides (contract 5.5) — never hand-authored with real values. */
  className?: string;
  childClassNames?: Record<string, string>;
  hidden?: boolean;
  childHidden?: Record<string, boolean>;
}

export interface TestimonialsProps {
  heading: string;
  testimonials: Testimonial[];
}

export default function Testimonials({ nodeId, heading, testimonials }: TestimonialsProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-16)">
      <Container>
        <Heading nodeId="home.testimonials.heading" level={2} variant="section" className="text-center">
          {heading}
        </Heading>
        <div data-node-id="home.testimonials.grid" className="mt-(--space-12) grid grid-cols-3 items-start gap-(--space-6)">
          {testimonials.map((testimonial) => {
            if (testimonial.hidden === true) return null;
            const testimonialId = `${nodeId}.testimonial-${testimonial.key}`;
            return (
              <div
                key={testimonial.key}
                data-node-id={testimonialId}
                className={cx(
                  "rounded-(--radius-md) border border-solid border-(--color-semantic-border)",
                  "bg-(--color-semantic-surface) p-(--space-6)",
                  testimonial.className,
                )}
              >
                {testimonial.childHidden?.quote !== true && (
                  <Text nodeId={`${testimonialId}.quote`} variant="lead" className={testimonial.childClassNames?.quote}>
                    {testimonial.quote}
                  </Text>
                )}
                {testimonial.childHidden?.attribution !== true && (
                  <Text
                    nodeId={`${testimonialId}.attribution`}
                    variant="eyebrow"
                    className={cx("mt-(--space-4)", testimonial.childClassNames?.attribution)}
                  >
                    {testimonial.attribution}
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
