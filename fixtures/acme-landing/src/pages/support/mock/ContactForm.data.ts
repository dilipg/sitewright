import type { ContactFormProps } from "../sections/ContactForm";

export const contactFormData: ContactFormProps = {
  heading: "Get in touch",
  description: "We reply within one business day.",
  namePlaceholder: "Your name",
  emailPlaceholder: "Your email",
  messagePlaceholder: "How can we help?",
  submitLabel: "Send message",
  onSubmit: (values) => {
    // TODO: integrate with a real endpoint (e.g. POST /api/contact)
    console.log("contact form submitted", values);
  },
};
