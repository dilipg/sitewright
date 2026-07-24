import Container from "../primitives/Container";
import { routes } from "./routes";

export default function Nav() {
  return (
    <header className="border-b border-solid border-(--color-semantic-border) bg-(--color-semantic-surface)">
      <Container className="flex items-center justify-between py-(--space-4)">
        <a
          href="/"
          className="font-(family-name:--typography-fontFamily-heading) text-(length:--typography-scale-lg) font-(--typography-weight-bold) text-(--color-semantic-text) no-underline"
        >
          Acme Analytics
        </a>
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
    </header>
  );
}
