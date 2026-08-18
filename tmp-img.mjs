import { chromium } from "playwright";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:5173/?project=${process.argv[2]}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="login-screen"]');
await page.fill('[data-testid="login-email"]', "admin");
await page.fill('[data-testid="login-password"]', "admin");
await page.click('button:has-text("Sign in")');
await page.waitForSelector('[data-testid="login-screen"]', { state: "detached", timeout: 25000 });

let nodes = 0;
for (let i = 0; i < 40; i++) {
  nodes = await page.evaluate(() => [...document.querySelectorAll("iframe")].reduce((a,f)=>a+(f.contentDocument?.querySelectorAll("[data-node-id]").length??0),0));
  if (nodes > 0) break;
  await page.waitForTimeout(1500);
}
console.log("the site renders :", nodes, "editable nodes");
console.log("failure banner   :", await page.isVisible('[data-testid="preview-failure"]').catch(()=>false));

const target = "home.product-gallery.product-ash-glaze-mug.image";
const before = await page.evaluate((id) => {
  for (const f of document.querySelectorAll("iframe")) {
    const el = f.contentDocument?.querySelector(`[data-node-id="${id}"]`);
    if (el) return (el.getAttribute("src") ?? el.querySelector("img")?.getAttribute("src") ?? "").slice(0, 40);
  }
  return null;
}, target);
console.log("src before       :", before);

await page.evaluate((id) => {
  for (const f of document.querySelectorAll("iframe")) {
    const el = f.contentDocument?.querySelector(`[data-node-id="${id}"]`);
    if (el) { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); return; }
  }
}, target);
await page.waitForTimeout(1500);

await page.fill('[data-testid="edit-prompt-input"]', "replace this image with https://images.unsplash.com/photo-1610701596007-11502861dcfa");
await page.click('[data-testid="edit-prompt-submit"]');

for (let i = 0; i < 45; i++) {
  const errs = await page.textContent('[data-testid="edit-prompt-errors"]').catch(() => null);
  const summary = await page.textContent('[data-testid="edit-prompt-summary"]').catch(() => null);
  const clarify = await page.textContent('[data-testid="edit-prompt-clarify"]').catch(() => null);
  const src = await page.evaluate((id) => {
    for (const f of document.querySelectorAll("iframe")) {
      const el = f.contentDocument?.querySelector(`[data-node-id="${id}"]`);
      if (el) return el.getAttribute("src") ?? el.querySelector("img")?.getAttribute("src") ?? "";
    }
    return "";
  }, target);
  if (errs) { console.log("REJECTED         :", errs.replace(/\s+/g," ").trim().slice(0,220)); break; }
  if (clarify) { console.log("AGENT ASKED      :", clarify.replace(/\s+/g," ").trim().slice(0,200)); break; }
  if (src.includes("unsplash")) { console.log("APPLIED          : src is now the new URL"); if (summary) console.log("summary          :", summary.replace(/\s+/g," ").trim().slice(0,160)); break; }
  await page.waitForTimeout(2000);
}
await browser.close();
