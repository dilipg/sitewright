export interface HeroProps {
  headline: string;
}

// home.hero.headline is attached to two elements.
export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <h2 data-node-id="home.hero.headline">{headline}</h2>
      <p data-node-id="home.hero.headline">{headline}</p>
    </section>
  );
}
