export interface HeroProps {
  headline: string;
}

export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <h2>{headline}</h2>
    </section>
  );
}
