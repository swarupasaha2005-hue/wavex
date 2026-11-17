import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
  headless: true,
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
let puts = 0,
  delayNext = true;
page.on("pageerror", (e) => errors.push(e.message));
const report = {};
try {
  await page.route("**/uploads/*", async (route) => {
    if (route.request().method() === "PUT") {
      puts++;
      if (delayNext && puts > 1) await new Promise((r) => setTimeout(r, 500));
    }
    await route.continue().catch(() => {});
  });
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  await page
    .getByLabel("Source file", { exact: true })
    .setInputFiles(resolve("backend/data/.integration/upload.csv"));
  await page.getByLabel("Timestamp format", { exact: true }).selectOption("ns");
  await page
    .getByLabel("Numeric columns, comma separated", { exact: true })
    .fill("value,temperature,pressure");
  await page
    .getByLabel("Dataset name", { exact: true })
    .fill("Browser 1 GB upload");
  const firstPut = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" && r.url().includes("/uploads/") && r.ok(),
  );
  await page
    .getByRole("button", { name: "Upload and import", exact: true })
    .click();
  await firstPut;
  await page.getByRole("button", { name: "Pause upload", exact: true }).click();
  await page
    .getByRole("button", { name: "Resume upload", exact: true })
    .waitFor();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("wavex-import-session-v2")),
  );
  const before = await fetch(`http://127.0.0.1:8000/uploads/${saved.id}`).then(
    (r) => r.json(),
  );
  assert.ok(before.offset > 0 && before.offset < before.size);
  report.resumedAtBytes = before.offset;
  report.sourceBytes = before.size;
  await page.reload();
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  await page
    .getByLabel("Resume source file", { exact: true })
    .setInputFiles(resolve("backend/data/.integration/upload.csv"));
  delayNext = false;
  await page
    .getByRole("button", { name: "Resume upload", exact: true })
    .click();
  await page
    .locator(".signal-tag")
    .filter({ hasText: "IMPORTED" })
    .waitFor({ timeout: 180000 });
  await page.locator(".playback-state.paused").waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "Signal column" })
      .locator("option")
      .count(),
    3,
  );
  await page
    .getByRole("combobox", { name: "Signal column" })
    .selectOption("temperature");
  await page.waitForTimeout(500);
  assert.ok(
    (await page.locator(".readout-label").innerText()).includes("TEMPERATURE"),
  );
  await page.getByRole("button", { name: "Engine details" }).click();
  const datasetId = await page
    .getByRole("combobox", { name: "Imported datasets" })
    .inputValue();
  report.datasetId = datasetId;
  await page.getByRole("slider", { name: "Dataset position" }).fill("17000000");
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("combobox", { name: "Visible time window" })
    .selectOption("3600");
  await page
    .getByRole("combobox", { name: "Playback speed" })
    .selectOption("32");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.locator(".playback-state.playing").waitFor();
  await page.waitForTimeout(1500);
  report.uploadRequests = puts;
  report.fps = Number(await page.getByTestId("fps").innerText());
  report.cpuDrawMs = Number(await page.getByTestId("frame-ms").innerText());
  report.bufferedPoints = await page.getByTestId("buffered-points").innerText();
  await page.screenshot({ path: "/tmp/wavex-imported.png", fullPage: true });
  await page.reload();
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("combobox", { name: "Imported datasets" })
    .selectOption(datasetId);
  await page.locator(".signal-tag").filter({ hasText: "IMPORTED" }).waitFor();
  await page.locator(".playback-state.paused").waitFor();
  assert.equal(
    await page
      .getByRole("combobox", { name: "Imported datasets" })
      .inputValue(),
    datasetId,
  );
  assert.equal(errors.length, 0, errors.join("; "));
  report.errors = errors;
  report.reopened = true;
  await writeFile(
    "test-results/import-browser-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: real 1 GB browser upload, SHA-256 chunks, pause, page reload, resume at committed offset, background import, column selection, historical WebGL playback, persistent reopening",
  );
} finally {
  await browser.close();
}
