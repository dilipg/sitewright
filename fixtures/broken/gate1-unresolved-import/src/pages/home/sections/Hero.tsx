import { formatHeadline } from "./format";

export interface HeroProps {
  headline: string;
}

export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <h2>{formatHeadline(headline)}</h2>
    </section>
  );
}
