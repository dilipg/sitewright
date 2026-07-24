export interface HeroProps {
  headline: string;
}

// home.hero.badge is attached to an element but missing from the manifest.
export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <span data-node-id="home.hero.badge">{headline}</span>
    </section>
  );
}
