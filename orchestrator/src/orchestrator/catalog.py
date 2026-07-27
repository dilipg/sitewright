"""Section archetype catalog v1 (pipeline 4.2) and page-archetype priors
(pipeline 4.3). Growing this catalog is the product's main ongoing content
work; the Planner may only draw from it (plus the budgeted `custom`)."""

ARCHETYPE_CATALOG: dict[str, str] = {
    # marketing / landing set
    "hero": "the page's opening statement: eyebrow, headline, subheadline, CTAs",
    "feature-grid": "grid of 3-6 feature cards, each icon-ish title + short copy",
    "feature-spotlight": "alternating media/copy rows spotlighting one feature each",
    "social-proof": "customer logos and/or short testimonials",
    "pricing-tiers": "2-4 pricing tier cards with feature lists and CTAs",
    "faq-accordion": "frequently asked questions as an accordion list",
    "cta-band": "full-width closing call-to-action band",
    "stats-band": "row of 3-4 headline numbers with labels",
    "team-grid": "grid of team members with names and roles",
    "contact-form": "contact form with typed submit handler seam",
    # storefront set
    "product-card-grid": "grid of product cards (image, name, price)",
    "product-detail": "single product: gallery plus buy box",
    "collection-header": "collection title, description, and filters header",
    "cart-drawer": "slide-out cart with line items and checkout CTA",
    "category-nav": "category navigation tiles or list",
    # saas set
    "integration-grid": "grid of integration/partner logos with blurbs",
    "comparison-table": "us-vs-them or plan comparison table",
    "changelog-list": "dated list of product updates",
    "docs-toc-page": "documentation table-of-contents page body",
}

# `custom` is the twentieth: allowed but budgeted (max 1 per page), logged as
# a signal for which archetype to build next (pipeline 4.4).
CUSTOM_ARCHETYPE = "custom"

PAGE_ARCHETYPES: dict[str, dict] = {
    "landing": {
        "min_sections": 4,
        "max_sections": 7,
        "first": "hero",
        "last": "cta-band",
        "prior": "hero first, cta-band last, 4-7 sections total",
    },
    "marketing-page": {
        "prior": "2-6 sections; lead with the page's subject (e.g. pricing-tiers on a pricing page)",
    },
    "storefront": {
        "prior": "commerce sections (collection-header, product-card-grid) plus trust builders",
    },
    "saas-product": {
        "prior": "feature-led sections with integration-grid/comparison-table where relevant",
    },
}
