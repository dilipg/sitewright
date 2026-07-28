import type { FaqProps } from "../sections/Faq";

export const faqData: FaqProps = {
  heading: "Frequently asked questions",
  items: [
    {
      key: "trial-length",
      question: "How long is the free trial?",
      answer: "14 days, full access, no credit card required to start.",
    },
    {
      key: "cancel-anytime",
      question: "Can I cancel anytime?",
      answer: "Yes — cancel from your account settings and you won't be billed again.",
    },
    {
      key: "data-export",
      question: "Can I export my data?",
      answer: "Every plan can export to CSV at any time, including on the free tier.",
    },
  ],
};
