import { heroData } from "./mock/Hero.data";
import Hero from "./sections/Hero";

/** Page assembly only, no styling decisions (contract section 2). */
export default function HomePage() {
  return <Hero nodeId="home.hero" {...heroData} />;
}
