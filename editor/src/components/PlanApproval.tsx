/** Plan-approval screen (pipeline 2.2): the cheapest correction point in
 * the whole system — nothing downstream spends until the user approves. */

export interface PlanBrief {
  brand: { name: string; oneLiner: string; tone: string; audience: string };
  assumptions?: string[];
}

export interface PlanSection {
  slug: string;
  archetype: string;
  brief: string;
}

export interface PlanRoute {
  slug: string;
  path: string;
  pageArchetype: string;
  title: string;
  sections: PlanSection[];
}

export interface PlanApprovalProps {
  brief: PlanBrief;
  routes: PlanRoute[];
  onEditBrief: (routeSlug: string, sectionSlug: string, brief: string) => void;
  onApprove: () => void;
}

export default function PlanApproval({ brief, routes, onEditBrief, onApprove }: PlanApprovalProps) {
  return (
    <div data-testid="plan-approval" className="plan-approval">
      <div className="plan-header">
        <div>
          <h1>{brief.brand.name}</h1>
          <p className="plan-oneliner">{brief.brand.oneLiner}</p>
          <p className="plan-meta">
            tone: {brief.brand.tone} · audience: {brief.brand.audience}
          </p>
          {brief.assumptions !== undefined && brief.assumptions.length > 0 && (
            <ul className="plan-assumptions">
              {brief.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" data-testid="plan-approve" className="plan-approve" onClick={onApprove}>
          Approve plan &amp; generate
        </button>
      </div>

      <div className="plan-routes">
        {routes.map((route) => (
          <section key={route.slug} data-testid="plan-route" className="plan-route">
            <header>
              <h2>{route.title}</h2>
              <code>{route.path}</code>
              <span className="badge">{route.pageArchetype}</span>
            </header>
            <ol>
              {route.sections.map((section) => (
                <li key={section.slug} className="plan-section">
                  <span data-testid="archetype-label" className="badge archetype-badge">
                    {section.archetype}
                  </span>
                  <textarea
                    data-testid={`section-brief-${route.slug}-${section.slug}`}
                    defaultValue={section.brief}
                    rows={2}
                    onBlur={(event) => onEditBrief(route.slug, section.slug, event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      <p className="plan-footnote">
        Reviewing this plan is free — generation spend starts only after approval.
      </p>
    </div>
  );
}
