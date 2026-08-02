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
    # app set: the SCREENS of a product, not pages about one. Spec 4.2 calls
    # growing this catalog "the main ongoing content work of the product".
    # Every one of these is still a presentational section with typed props and
    # handler seams (contract 5.x) -- an app screen here means the UI layer of
    # a builder or a data table, not a working one.
    "app-shell": "application chrome: top bar with an inline-editable title, save-status, segmented view tabs and a primary action",
    "element-palette": "searchable, grouped library of draggable element cards for a builder's left rail",
    "builder-canvas": "a builder's centre work area: ordered field cards with selected/hover affordances, a drop indicator and an empty state",
    "properties-inspector": "context panel of tabbed settings for the selected element: labels, an option list manager, and validation toggles",
    "form-renderer": "a public, fillable form: header, optional progress, typed field list with per-field validation states, and a submit footer",
    "data-toolbar": "a data view's control bar: breadcrumb, date-range and search filters, and an export menu",
    "data-grid": "dense sortable/filterable submission table with row selection, read/unread rows, truncated cells and pagination",
    "detail-drawer": "side-peek panel showing one record as key/value rows with media thumbnails and footer actions",
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
    # Spec 4.3: "A page archetype is just a Planner-side prior ... It adds no
    # prompt blocks of its own." This one exists so the planner can lay out a
    # screen INSIDE a product rather than a page marketing one -- without it,
    # every app brief is forced onto a marketing archetype and comes back as a
    # landing page about the app.
    "app-screen": {
        "min_sections": 2,
        "max_sections": 5,
        "first": "app-shell",
        "prior": (
            "app-shell first (the screen's own chrome), then the panes of the screen "
            "left-to-right or top-to-bottom; 2-5 sections; NO hero and NO cta-band -- "
            "this is a signed-in working surface, not a marketing page"
        ),
    },
}


def main() -> None:
    """Dumps the catalog as JSON so the editor's add-a-section picker (PRD 4.1)
    can list archetypes without a second copy of this table in TypeScript. A
    duplicate would offer the user a section the generator cannot build the
    moment the two drift, since this table is what decides which archetypes
    have prompt templates.

    A module entry point rather than `python -c`: the preview server spawns
    through a shell, which does not quote arguments on Windows, so a `-c`
    expression containing spaces and a semicolon gets split into pieces.
    """
    import json

    print(json.dumps(ARCHETYPE_CATALOG))


if __name__ == "__main__":
    main()
