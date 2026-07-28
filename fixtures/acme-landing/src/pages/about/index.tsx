import { aboutIntroData } from "./mock/AboutIntro.data";
import AboutIntro from "./sections/AboutIntro";

/** Page assembly only, no styling decisions (contract section 2). */
export default function AboutPage() {
  return <AboutIntro nodeId="about.intro" {...aboutIntroData} />;
}
