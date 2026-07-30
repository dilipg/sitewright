import { contactFormData } from "./mock/ContactForm.data";
import ContactForm from "./sections/ContactForm";

/** Page assembly only, no styling decisions (contract section 2). */
export default function SupportPage() {
  return (
    <>
      <ContactForm nodeId="support.contact-form" {...contactFormData} />
    </>
  );
}
