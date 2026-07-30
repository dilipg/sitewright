/** Ground-truth route table (contract section 2). Every internal href must exist here. */
export interface RouteDef {
  slug: string;
  path: string;
  title: string;
}

export const routes: RouteDef[] = [
  { slug: "home", path: "/", title: "Home" },
  { slug: "about", path: "/about", title: "About" },
  { slug: "support", path: "/support", title: "Support" },
];
