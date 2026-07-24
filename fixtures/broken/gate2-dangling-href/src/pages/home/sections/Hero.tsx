export interface HeroProps {
  headline: string;
}

export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <a href="/pricing">{headline}</a>
    </section>
  );
}
