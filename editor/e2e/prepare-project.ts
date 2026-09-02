/**
 * e2e serves a disposable copy of the fixture from generated/ (gitignored):
 * style-channel tests write override files, and the fixture must stay
 * pristine. node_modules is borrowed from the fixture via a junction.
 * Runs as the first step of the preview webServer command (Playwright
 * launches webServers before globalSetup, so setup lives in the command).
 */
import { cpSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
// `removeDirectoryLink` rather than a local `rmdirSync`: this was the NINTH copy
// of the same defect (whole-branch review). `rmdirSync` removes a Windows
// junction but throws `ENOTDIR` on a POSIX symlink, so on Linux or macOS the
// SECOND run of the e2e setup failed here — outside the reach of the Python-only
// portability guard. That helper branches on `lstatSync` and is tested.
import { removeDirectoryLink } from "@sitewright/compiler";

const fixtureDir = fileURLToPath(new URL("../../fixtures/acme-landing", import.meta.url));
const projectDir = fileURLToPath(new URL("../../generated/editor-e2e-project", import.meta.url));

const linkedModules = join(projectDir, "node_modules");
if (existsSync(linkedModules)) {
  removeDirectoryLink(linkedModules); // removes the LINK, never the fixture's tree
}
if (existsSync(projectDir)) {
  rmSync(projectDir, { recursive: true, force: true });
}
cpSync(fixtureDir, projectDir, {
  recursive: true,
  filter: (src) => !src.includes(`${sep}node_modules`) && !src.includes(`${sep}dist`),
});
symlinkSync(join(fixtureDir, "node_modules"), linkedModules, "junction");
console.log(`prepared ${projectDir}`);
