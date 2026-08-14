/**
 * The browser tab's title, per screen.
 *
 * WHY (dogfood finding G8): the tab read **"Editor"** on every screen — login,
 * key form, sites list, an eleven-minute generation, and the canvas — so two
 * tabs of this app were indistinguishable, and a tester watching a paid run in
 * one tab could not tell it from the tab they were reading the docs in.
 *
 * HOSTED MODE ONLY, and the guard lives at the one call site rather than here
 * (`App.tsx`'s title effect). Local mode must stay byte-identical: `index.html`
 * ships `<title>Editor</title>`, the milestone-7 Playwright suite runs against
 * the local, unauthenticated preview server, and a title this module set there
 * would be a behaviour change in the one mode that is not allowed one.
 *
 * THE CANVAS TITLE NAMES THE PROJECT BY ITS ID PREFIX, not by its name, and
 * that is a limit rather than a preference: the canvas never loads
 * `GET /api/projects`, so the human name the picker shows (the brief, truncated
 * by the server) is simply not in hand there. The first eight characters of the
 * id ARE in hand — they are on the URL, in `?project=` — so a user can match a
 * tab to its address bar and to nothing else. Fetching the name to improve this
 * would add a request to the canvas bootstrap path, which is the path this
 * codebase has already had to fix three silent hangs in.
 */

/** Which screen `App` is rendering. One name per early return in `App`'s own
 *  render, so a new screen cannot silently inherit another's title. */
export type EditorScreen =
  | "login"
  | "checking"
  | "picker"
  | "key"
  | "generating"
  | "unopenable"
  | "plan"
  | "canvas";

/** The product name, last in every title so a truncated tab still shows the
 *  distinguishing half. */
export const APP_TITLE = "Website Generator";

/** How much of a project id identifies it to a human. Eight hex characters is
 *  what `user-cli list-projects`, the picker's own URLs and every id in this
 *  codebase's reports are recognised by. */
const ID_PREFIX_LENGTH = 8;

const SCREEN_TITLES: Readonly<Record<Exclude<EditorScreen, "canvas">, string>> = {
  login: "Sign in",
  // Deliberately not "Loading": this screen is specifically the session probe,
  // and it is the screen a tester stares at when the hosted server is down.
  checking: "Checking your session",
  picker: "Your sites",
  key: "Your API key",
  // The tab is how a tester finds the run again after switching away from it
  // for eleven minutes, so this is the title that matters most.
  generating: "Generating your site",
  unopenable: "Site could not be opened",
  plan: "Approve the plan",
};

/**
 * The document title for a screen. `projectId` is read only for the canvas, and
 * only as a prefix; an absent one degrades to the bare product name rather than
 * rendering "Editing undefined".
 */
export function documentTitleFor(screen: EditorScreen, projectId?: string): string {
  if (screen !== "canvas") return `${SCREEN_TITLES[screen]} · ${APP_TITLE}`;
  if (projectId === undefined || projectId === "") return APP_TITLE;
  return `Editing ${projectId.slice(0, ID_PREFIX_LENGTH)} · ${APP_TITLE}`;
}
