import type { ReactNode } from "react";
import Footer from "./Footer";
import Nav from "./Nav";

export interface AppShellProps {
  children: ReactNode;
}

/** Layout frame: nav + outlet + footer (contract section 2). */
export default function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-(--color-semantic-bg) font-(family-name:--typography-fontFamily-body) text-(--color-semantic-text)">
      <Nav />
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}
