export interface HeroProps {
  headline: string;
}

// The manifest registers home.hero.headline, but no element carries it.
export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <h2>{headline}</h2>
    </section>
  );
}
