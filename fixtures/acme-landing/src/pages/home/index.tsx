import { capabilitiesData } from "./mock/Capabilities.data";
import { ctaBandData } from "./mock/CtaBand.data";
import { faqData } from "./mock/Faq.data";
import { heroData } from "./mock/Hero.data";
import { pricingData } from "./mock/Pricing.data";
import { testimonialsData } from "./mock/Testimonials.data";
import Capabilities from "./sections/Capabilities";
import CtaBand from "./sections/CtaBand";
import Faq from "./sections/Faq";
import Hero from "./sections/Hero";
import Pricing from "./sections/Pricing";
import Testimonials from "./sections/Testimonials";

/** Page assembly only, no styling decisions (contract section 2). */
export default function HomePage() {
  return (
    <>
      <Hero nodeId="home.hero" {...heroData} />
      <Capabilities nodeId="home.capabilities" {...capabilitiesData} />
      <Pricing nodeId="home.pricing" {...pricingData} />
      <Testimonials nodeId="home.testimonials" {...testimonialsData} />
      <Faq nodeId="home.faq" {...faqData} />
      <CtaBand nodeId="home.cta-band" {...ctaBandData} />
    </>
  );
}
