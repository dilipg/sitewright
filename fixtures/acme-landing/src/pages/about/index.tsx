import FailedSectionPlaceholder from "../../lib/FailedSectionPlaceholder";
import { aboutIntroData } from "./mock/AboutIntro.data";
import AboutIntro from "./sections/AboutIntro";

/** Page assembly only, no styling decisions (contract section 2).
 *
 * The placeholder is deliberate fixture coverage, not a defect: it is the
 * shape a page takes when one section exhausts its bounded retries (pipeline
 * 5.4 / failure table row 4), and the editor, the gates and the exporter all
 * have to keep working around it. Assembled exactly as
 * assemble_page_index_source emits it — no nodeId, because no agent ever
 * proposed a manifest entry for a section that never produced structured
 * output. */
export default function AboutPage() {
  return (
    <>
      <AboutIntro nodeId="about.intro" {...aboutIntroData} />
      <FailedSectionPlaceholder />
    </>
  );
}
