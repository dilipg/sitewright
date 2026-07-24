import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import HomePage from "./pages/home";
import AppShell from "./shell/AppShell";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppShell>
      <HomePage />
    </AppShell>
  </StrictMode>,
);
