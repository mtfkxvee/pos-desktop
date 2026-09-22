/**
 * Dev orchestrator: starts the Vite dev server for the renderer, waits for
 * it to actually be ready, then launches Electron pointed at it
 * (VITE_DEV_SERVER_URL — see main/index.js) instead of the built dist/
 * bundle. Without this, `electron .` always loads renderer/dist/index.html,
 * a static build that silently goes stale the moment a .vue/.js source file
 * changes — every renderer edit needs `npm run build:renderer` to actually
 * take effect. This makes "npm run dev" mean what it says.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const DEV_SERVER_URL = "http://localhost:5173";

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function main() {
  const isWin = process.platform === "win32";
  const npmCmd = isWin ? "npm.cmd" : "npm";

  const vite = spawn(npmCmd, ["run", "dev"], {
    cwd: RENDERER_DIR,
    stdio: "inherit",
    shell: isWin,
  });

  let electron = null;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (electron && !electron.killed) electron.kill();
    if (vite && !vite.killed) vite.kill();
  };

  vite.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[dev] Vite dev server exited early (code ${code})`);
      shutdown();
      process.exit(code || 1);
    }
  });

  try {
    await waitForServer(DEV_SERVER_URL);
  } catch (err) {
    console.error(`[dev] ${err.message}`);
    shutdown();
    process.exit(1);
  }

  // require("electron") from plain Node (not running under Electron itself)
  // resolves to the path of the electron binary, not the API — avoids
  // spawning through npm.cmd (and its shell:true quoting headaches) a
  // second time.
  const electronPath = require("electron");
  electron = spawn(electronPath, ["."], {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_SERVER_URL },
  });

  electron.on("exit", (code) => {
    shutdown();
    process.exit(code || 0);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
