// Reaches into another page's directory — sections are page-private.
import Promo from "../pricing/sections/Promo";
import Hero from "./sections/Hero";

export default function HomePage() {
  return (
    <>
      <Hero headline={"Answers, faster"} />
      <Promo />
    </>
  );
}
