import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
const directory = await mkdtemp(join(tmpdir(), "wavex-import-test-"));
const source = join(directory, "retry.csv");
await writeFile(
  source,
  "timestamp,value\n" +
    Array.from(
      { length: 10000 },
      (_, i) =>
        `${1789344000000000000n + BigInt(i) * 10000000n},${(72 + Math.sin(i / 80) * 8).toFixed(6)}\n`,
    ).join(""),
);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  reducedMotion: "reduce",
  viewport: { width: 1280, height: 900 },
});
const errors = [];
let chunks = 0;
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (r.method() === "PUT" && r.url().includes("/uploads/")) chunks++;
});
const report = {};
try {
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  await page.getByLabel("Source file", { exact: true }).setInputFiles(source);
  await page
    .getByLabel("Dataset name", { exact: true })
    .fill("Mapping retry smoke");
  await page
    .getByRole("button", { name: "Upload and import", exact: true })
    .click();
  await page.locator(".import-error").waitFor({ timeout: 30000 });
  assert.ok(
    await page.getByLabel("Timestamp format", { exact: true }).isEnabled(),
  );
  const before = chunks;
  await page.getByLabel("Timestamp format", { exact: true }).selectOption("ns");
  await page.getByRole("button", { name: "Retry import", exact: true }).click();
  await page
    .locator(".signal-tag")
    .filter({ hasText: "IMPORTED" })
    .waitFor({ timeout: 30000 });
  await page.locator(".playback-state.paused").waitFor();
  assert.equal(
    chunks,
    before,
    "Correcting mapping must reuse the retained upload",
  );
  report.uploadDataset = await page
    .getByRole("combobox", { name: "Imported datasets" })
    .inputValue();
  report.uploadChunks = chunks;
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Local file path", exact: true })
    .click();
  await page.getByLabel("Local file path", { exact: true }).fill(source);
  await page.getByLabel("Timestamp format", { exact: true }).selectOption("ns");
  await page
    .getByLabel("Dataset name", { exact: true })
    .fill("Local path smoke");
  await page
    .getByRole("button", { name: "Import local file", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".signal-title h2")?.textContent ===
      "Local path smoke",
    { timeout: 30000 },
  );
  await page.locator(".playback-state.paused").waitFor();
  report.localDataset = await page
    .getByRole("combobox", { name: "Imported datasets" })
    .inputValue();
  assert.equal(chunks, before);
  assert.ok((await stat(source)).size > 0);
  assert.equal(errors.length, 0, errors.join("; "));
  report.errors = errors;
  await writeFile(
    "test-results/import-retry-ui.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  console.log(
    "PASS: browser mapping correction retries without reupload, local-path UI import adds no upload request and preserves its original source",
  );
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
