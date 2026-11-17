import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: true,
});
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let hold = false,
    release;
  let gate = Promise.resolve();
  await page.route("**/datasets/*/range?*", async (route) => {
    if (hold) await gate;
    await route.continue().catch(() => {});
  });
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await page.locator(".playback-state.paused").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Engine details" }).click();
  assert.ok(
    Number(
      (
        await page.locator(".engine-details strong").nth(1).innerText()
      ).replaceAll(",", ""),
    ) > 0,
  );
  const snapshot = () =>
    page.locator(".main-canvas").evaluate((c) => c.toDataURL());
  const first = await snapshot();
  await page.waitForTimeout(400);
  assert.equal(await snapshot(), first);
  hold = true;
  gate = new Promise((r) => (release = r));
  await page.getByRole("slider", { name: "Dataset position" }).fill("700000");
  await page.locator(".playback-state.buffering").waitFor();
  assert.equal(
    await snapshot(),
    first,
    "A cold seek preserves the last complete frame",
  );
  hold = false;
  release();
  await page.locator(".playback-state.paused").waitFor();
  assert.notEqual(await snapshot(), first);
  await page.getByRole("button", { name: "Open keyboard shortcuts" }).click();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    ),
    "Close keyboard shortcuts",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const offline = await context.newPage();
  await offline.route("http://127.0.0.1:8000/**", (route) => route.abort());
  await offline.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await offline.locator(".error-banner[role=alert]").waitFor();
  await offline.unroute("http://127.0.0.1:8000/**");
  await offline.getByRole("button", { name: "Retry" }).click();
  await offline.locator(".playback-state.paused").waitFor({ timeout: 15000 });
  assert.equal(errors.length, 0, errors.join("; "));
  console.log(
    "PASS: reduced-motion first frame, bounded real-query delay, paused cold seek, no buffering flicker, keyboard dialog, offline API error and retry",
  );
} finally {
  await browser.close();
}
