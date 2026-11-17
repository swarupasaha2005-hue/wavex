import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const datasets = await fetch("http://127.0.0.1:8000/datasets").then((r) =>
  r.json(),
);
const dataset = datasets.find(
  (d) => d.sourceBytes >= 1e10 && d.label === "10 GB integration",
);
assert.ok(dataset, "Import the 10 GB integration file first");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  datasetId: dataset.id,
  sourceBytes: dataset.sourceBytes,
  sourceRows: dataset.size,
  seeks: [],
};
try {
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await page.locator(".playback-state.paused").waitFor();
  await page
    .getByRole("combobox", { name: "Imported datasets" })
    .selectOption(dataset.id);
  await page.locator(".signal-tag").filter({ hasText: "IMPORTED" }).waitFor();
  await page.locator(".playback-state.paused").waitFor();
  await page.getByRole("button", { name: "Engine details" }).click();
  for (const [fraction, window] of [
    [0.01, "1"],
    [0.2, "30"],
    [0.5, "120"],
    [0.8, "3600"],
    [0.9, "86400"],
  ]) {
    const started = Date.now();
    await page
      .getByRole("combobox", { name: "Visible time window" })
      .selectOption(window);
    await page
      .getByRole("slider", { name: "Dataset position" })
      .fill(String(Math.floor((dataset.size - 1) * fraction)));
    await page.locator(".playback-state.paused").waitFor();
    await page.waitForTimeout(350);
    report.seeks.push({
      fraction,
      windowSeconds: Number(window),
      includingReadoutWaitMs: Date.now() - started,
      buffer: await page.getByTestId("buffered-points").innerText(),
    });
    assert.ok(
      Number(
        (await page.getByTestId("buffered-points").innerText())
          .split(" /")[0]
          .replaceAll(",", ""),
      ) <= 24576,
    );
  }
  await page
    .getByRole("combobox", { name: "Visible time window" })
    .selectOption("120");
  const overviewResponse=page.waitForResponse(response => {const url=new URL(response.url());return url.pathname.endsWith("/range") && url.searchParams.get("columns")==="temperature" && url.searchParams.get("max_points")==="1600";});
  await page
    .getByRole("combobox", { name: "Signal column" })
    .selectOption("temperature");
  const overview=await (await overviewResponse).json();
  assert.ok(overview.series.temperature.values.length>0 && Math.max(...overview.series.temperature.values)<100,"The timeline must query the selected column's real overview");

  await page
    .getByRole("combobox", { name: "Playback speed" })
    .selectOption("32");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.locator(".playback-state.playing").waitFor();
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    samples.push({
      fps: Number(await page.getByTestId("fps").innerText()),
      cpuDrawMs: Number(await page.getByTestId("frame-ms").innerText()),
    });
  }
  report.samples = samples;
  report.averageFps = samples.reduce((s, x) => s + x.fps, 0) / samples.length;
  report.averageCpuDrawMs =
    samples.reduce((s, x) => s + x.cpuDrawMs, 0) / samples.length;
  await page.screenshot({ path: "/tmp/wavex-ten-gb.png", fullPage: true });
  report.browserErrors = errors;
  assert.equal(errors.length, 0, errors.join("; "));
  await writeFile(
    "test-results/ten-gb-playback.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: real 10 GB import browsed through the UI, distant seeks, 1s–1day windows, column changes, bounded cache and 32× WebGL playback",
  );
} finally {
  await browser.close();
}
