import Container from "../primitives/Container";
import { routes } from "./routes";

export default function Footer() {
  return (
    <footer className="border-t border-solid border-(--color-semantic-border)">
      <Container className="flex items-center justify-between py-(--space-8)">
        <p className="text-(length:--typography-scale-sm) text-(--color-semantic-textMuted)">
          Acme Analytics — product analytics for small teams.
        </p>
        <nav className="flex gap-(--space-6)">
          {routes.map((route) => (
            <a
              key={route.slug}
              href={route.path}
              className="text-(length:--typography-scale-sm) text-(--color-semantic-textMuted) no-underline"
            >
              {route.title}
            </a>
          ))}
        </nav>
      </Container>
    </footer>
  );
}
