import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        headless: true,
      }
    : { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", headless: true },
);
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "no-preference",
});
const errors = [],
  requests = [];
let websockets = 0;
page.on("pageerror", (e) => errors.push(e.message));
page.on("websocket", (socket) => {
  if (socket.url().includes(":8000/")) websockets++;
});
page.on("request", (r) => {
  if (r.url().includes("/range?")) requests.push(r.url());
});
const pause = async () => {
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.locator(".playback-state.paused").waitFor();
};
const playing = () =>
  page.locator(".playback-state.playing").waitFor({ timeout: 30000 });
const position = async () =>
  Number(
    await page.getByRole("slider", { name: "Dataset position" }).inputValue(),
  );
const seek = async (value) => {
  await page
    .getByRole("slider", { name: "Dataset position" })
    .fill(String(value));
  await page.locator(".playback-state.paused").waitFor();
  await page.waitForTimeout(300);
};
const report = {
  environment:
    "Headless Google Chrome, 1440×1000, local machine; historical HTTP queries + WebGL",
  sizes: {},
};
try {
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:3000");
  await playing();
  await page.getByRole("button", { name: "Engine details" }).click();
  const initial = await position();
  await page.waitForTimeout(1000);
  assert.ok((await position()) > initial + 50);
  await pause();
  const stopped = await position();
  const image = await page
    .locator(".main-canvas")
    .evaluate((c) => c.toDataURL());
  await page.waitForTimeout(500);
  assert.equal(await position(), stopped);
  assert.equal(
    await page.locator(".main-canvas").evaluate((c) => c.toDataURL()),
    image,
  );
  await page
    .getByRole("combobox", { name: "Visible time window" })
    .selectOption("1");
  await seek(785432);
  const expected = await page.evaluate(async () => {
    const ns = 1789344000000000000n + 785432n * 10000000n;
    const q = await fetch(
      `http://127.0.0.1:8000/datasets/telemetry-1000000-42/range?start_ns=${ns}&end_ns=${ns}&max_points=32`,
    ).then((r) => r.json());
    return q.series.value.values[0].toFixed(2);
  });
  assert.equal(
    (await page.locator(".current-value").innerText()).split("\n")[0],
    expected,
  );
  assert.notEqual(
    await page.locator(".main-canvas").evaluate((c) => c.toDataURL()),
    image,
  );
  await page.getByRole("button", { name: "Restart playback" }).click();
  await playing();
  assert.ok((await position()) < 1000);
  for (const size of [10000, 100000, 1000000, 10000000]) {
    await page
      .getByRole("combobox", { name: "DATASET SIZE" })
      .selectOption(String(size));
    await page.getByRole("button", { name: "Load dataset" }).click();
    await page.waitForFunction(
      (size) =>
        document.querySelector('input[aria-label="Dataset position"]')?.max ===
        String(size - 1),
      size,
    );
    await playing();
    await page.waitForTimeout(400);
    report.sizes[size] = {
      fps: Number(await page.getByTestId("fps").innerText()),
      drawMs: Number(await page.getByTestId("frame-ms").innerText()),
    };
  }
  await pause();
  await page
    .getByRole("combobox", { name: "Visible time window" })
    .selectOption("120");
  for (const value of [9000000, 2000000, 7000000, 4000000, 5000000]) {
    await seek(value);
    const count = Number(
      (await page.getByTestId("buffered-points").innerText())
        .split(" /")[0]
        .replaceAll(",", ""),
    );
    assert.ok(count <= 24576);
  }
  await page
    .getByRole("combobox", { name: "Playback speed" })
    .selectOption("32");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await playing();
  const samples = [];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    samples.push({
      fps: Number(await page.getByTestId("fps").innerText()),
      drawMs: Number(await page.getByTestId("frame-ms").innerText()),
      position: await position(),
    });
  }
  assert.ok(samples.at(-1).position > samples[0].position + 10000);
  report.stress = {
    windowSeconds: 120,
    speed: 32,
    samples,
    averageFps: samples.reduce((a, x) => a + x.fps, 0) / samples.length,
    averageCpuDrawMs:
      samples.reduce((a, x) => a + x.drawMs, 0) / samples.length,
  };
  await pause();
  await page.getByRole("slider", { name: "Dataset position" }).fill("9999999");
  await page.locator(".playback-state.ended").waitFor();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await playing();
  await page.locator("h1").click();
  await page.keyboard.press("Space");
  await page.locator(".playback-state.paused").waitFor();
  const before = await position();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  assert.ok((await position()) >= before + 999);
  await page
    .getByRole("combobox", { name: "Playback speed" })
    .selectOption("1");
  await page
    .getByRole("combobox", { name: "Visible time window" })
    .selectOption("30");
  await seek(10000);
  const plot = await page.locator(".main-canvas").boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + 100);
  await page.mouse.down();
  await page.mouse.move(plot.x + plot.width * 0.6, plot.y + 100, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  assert.ok((await position()) < 10000, "Drag pans the actual dataset clock");
  const previousWindow = await page
    .getByRole("combobox", { name: "Visible time window" })
    .inputValue();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  assert.notEqual(
    await page
      .getByRole("combobox", { name: "Visible time window" })
      .inputValue(),
    previousWindow,
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save graph as PNG" }).click();
  assert.ok((await download).suggestedFilename().endsWith(".png"));
  await page.getByRole("button", { name: "Expand graph" }).click();
  assert.ok(await page.locator(".graph-panel.expanded").isVisible());
  await page.getByRole("button", { name: "Exit expanded view" }).click();
  await page.screenshot({ path: "/tmp/wavex-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("button", { name: "Import dataset", exact: true })
    .click();
  await page.getByRole("region", { name: "Import dataset" }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "/tmp/wavex-mobile.png", fullPage: true });
  assert.equal(websockets, 0, "Historical replay must not use WebSockets");
  assert.equal(errors.length, 0, errors.join("; "));
  assert.ok(requests.length > 10);
  report.historicalQueries = requests.length;
  report.websockets = websockets;
  report.browserErrors = errors;
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/browser-report.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: historical HTTP playback, WebGL frames, actual recorded sample, play/pause/restart/speed, seek, LOD zoom, cache bounds, pan, wheel zoom, all synthetic sizes, EOF, export, mobile, import controls",
  );
} finally {
  await browser.close();
}
