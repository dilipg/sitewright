export interface HeroProps {
  headline: string;
}

// User-visible copy is hardcoded instead of flowing through props.
export default function Hero(_props: HeroProps) {
  return (
    <section data-node-id="home.hero">
      <h2 data-node-id="home.hero.headline">Welcome to Acme</h2>
    </section>
  );
}
