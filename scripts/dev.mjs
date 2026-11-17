import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const python = join(
  root,
  process.platform === "win32"
    ? "backend/.venv/Scripts/python.exe"
    : "backend/.venv/bin/python",
);
if (!existsSync(python)) {
  console.error(
    "Set up the backend first: python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt",
  );
  process.exit(1);
}
const children = [
  spawn(
    python,
    [
      "-m",
      "uvicorn",
      "backend.app.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
    ],
    { stdio: "inherit", cwd: root },
  ),
  spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("next/dist/bin/next")),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
    ],
    {
      stdio: "inherit",
      cwd: join(root, "frontend"),
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const child of children) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
