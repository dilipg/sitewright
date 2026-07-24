export interface HeroProps {
  headline: string;
}

export default function Hero({ headline }: HeroProps) {
  return (
    <section data-node-id="home.hero" style={{ background: "#ff0000", padding: "16px" }}>
      <h2>{headline}</h2>
    </section>
  );
}
