import { cx } from "../../../lib/cx";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import type { NodeProps } from "../../../lib/types";

export interface FaqItem {
  key: string;
  question: string;
  answer: string;
  /** Export-compiled overrides (contract 5.5) — never hand-authored with real values. */
  className?: string;
  childClassNames?: Record<string, string>;
  hidden?: boolean;
  childHidden?: Record<string, boolean>;
}

export interface FaqProps {
  heading: string;
  items: FaqItem[];
}

export default function Faq({ nodeId, heading, items }: FaqProps & NodeProps) {
  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-surface) py-(--space-16)">
      <Container>
        <Heading nodeId="home.faq.heading" level={2} variant="section" className="text-center">
          {heading}
        </Heading>
        <div data-node-id="home.faq.list" className="mx-auto mt-(--space-12) flex max-w-[40rem] flex-col gap-(--space-6)">
          {items.map((item) => {
            if (item.hidden === true) return null;
            const itemId = `${nodeId}.item-${item.key}`;
            return (
              <div
                key={item.key}
                data-node-id={itemId}
                className={cx(
                  "border-b border-solid border-(--color-semantic-border) p-(--space-4) pb-(--space-6)",
                  item.className,
                )}
              >
                {item.childHidden?.question !== true && (
                  <Heading nodeId={`${itemId}.question`} level={3} variant="subsection" className={item.childClassNames?.question}>
                    {item.question}
                  </Heading>
                )}
                {item.childHidden?.answer !== true && (
                  <Text
                    nodeId={`${itemId}.answer`}
                    variant="body"
                    className={cx("mt-(--space-2)", item.childClassNames?.answer)}
                  >
                    {item.answer}
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
