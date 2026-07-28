import type { ComponentType } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import AppShell from "./shell/AppShell";
import { routes } from "./shell/routes";

// Page components are discovered by directory, not imported by name, so this
// file never has to change as Page Agents add or remove routes (src/main.tsx
// is unowned scaffold, not agent-generated — see CLAUDE.md's ownership map).
const pageModules = import.meta.glob<{ default: ComponentType }>("./pages/*/index.tsx", { eager: true });

function pageComponent(slug: string): ComponentType | undefined {
  return pageModules[`./pages/${slug}/index.tsx`]?.default;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppShell>
        <Routes>
          {routes.flatMap((route) => {
            const Page = pageComponent(route.slug);
            return Page === undefined ? [] : [<Route key={route.slug} path={route.path} element={<Page />} />];
          })}
        </Routes>
      </AppShell>
    </BrowserRouter>
  </StrictMode>,
);
