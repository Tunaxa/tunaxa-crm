import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const apiUrl = process.env.API_HEALTH_URL || "http://127.0.0.1:3001/api/health";
let apiProcess;
let webProcess;
let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function apiIsReady() {
  try {
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

async function waitForApi(timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await apiIsReady()) return true;
    if (apiProcess?.exitCode !== null && apiProcess?.exitCode !== undefined)
      return false;
    await sleep(250);
  }
  return false;
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (webProcess && !webProcess.killed) webProcess.kill();
  if (apiProcess && !apiProcess.killed) apiProcess.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);

async function main() {
  console.log("Starting Tunaxa CRM...");

  if (!(await apiIsReady())) {
    apiProcess = spawn(
      process.execPath,
      [path.join(root, "backend", "server.js")],
      {
        cwd: root,
        stdio: "inherit",
      },
    );

    const ready = await waitForApi();
    if (!ready) {
      if (apiProcess?.exitCode === null) apiProcess.kill();
      throw new Error(
        "The Tunaxa backend could not start on 127.0.0.1:3001. Check whether another app is using port 3001.",
      );
    }
  } else {
    console.log("Tunaxa API is already running.");
  }

  console.log("Backend ready. Starting the interface...");

  webProcess = spawn(
    process.execPath,
    [
      path.join(root, "node_modules", "vite", "bin", "vite.js"),
      "--config",
      path.join(root, "web", "vite.config.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      "5173",
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );

  webProcess.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });

  if (apiProcess) {
    apiProcess.on("exit", (code) => {
      if (stopping) return;
      console.error(
        `Backend stopped unexpectedly${code === null ? "" : ` with code ${code}`}.`,
      );
      if (webProcess && !webProcess.killed) webProcess.kill();
      process.exitCode = code || 1;
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  stop();
  process.exitCode = 1;
});
