import type { PricingProps } from "../sections/Pricing";

export const pricingData: PricingProps = {
  heading: "Simple, transparent pricing",
  description: "Every plan includes unlimited teammates. Upgrade or downgrade anytime.",
  tiers: [
    {
      key: "starter",
      name: "Starter",
      price: "$0/mo",
      description: "For individuals trying Acme out on a single project.",
      ctaLabel: "Start free",
      ctaHref: "/",
    },
    {
      key: "growth",
      name: "Growth",
      price: "$29/mo",
      description: "For small teams that need shared dashboards and exports.",
      ctaLabel: "Start trial",
      ctaHref: "/",
      badgeLabel: "Most popular",
    },
    {
      key: "scale",
      name: "Scale",
      price: "$99/mo",
      description: "For companies that need SSO, audit logs, and priority support.",
      ctaLabel: "Talk to sales",
      ctaHref: "/",
    },
  ],
};
