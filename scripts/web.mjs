#!/usr/bin/env node
// Launch the Next.js web/API server on the configured host/port.
// Precedence: PORT/HOST env vars > config server.port/server.host > defaults.
// Usage: node scripts/web.mjs <dev|start>
import { spawn, execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Resolve the deployed git commit at launch (cwd is the repo root here, unlike the bundled Next
// server where reading .git is unreliable) and inject it so the UI build tag is accurate. Tries
// the git binary, then falls back to reading .git directly (symbolic HEAD, packed-refs, detached).
function resolveCommit() {
  if (process.env.HOPWATCH_GIT_COMMIT) return process.env.HOPWATCH_GIT_COMMIT.slice(0, 12);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* git binary unavailable: read .git */
  }
  try {
    const head = readFileSync(".git/HEAD", "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      try {
        return readFileSync(`.git/${ref}`, "utf8").trim().slice(0, 7);
      } catch {
        const packed = readFileSync(".git/packed-refs", "utf8");
        const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
        if (line) return line.slice(0, 7);
      }
    } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return head.slice(0, 7);
    }
  } catch {
    /* no .git: leave unset */
  }
  return "";
}

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const mode = process.argv[2] === "dev" ? "dev" : "start";

let host = "0.0.0.0";
let port = "3000";
try {
  const { parse } = await import("yaml");
  const y = parse(readFileSync("config/hopwatch.yaml", "utf8"));
  if (y?.server?.host) host = String(y.server.host);
  if (y?.server?.port) port = String(y.server.port);
} catch {
  /* config not present yet; use defaults */
}
if (process.env.PORT) port = process.env.PORT;
if (process.env.HOST) host = process.env.HOST;

const commit = resolveCommit();
const child = spawn("next", [mode, "-p", port, "-H", host], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, HOPWATCH_GIT_COMMIT: commit },
});
child.on("exit", (code) => process.exit(code ?? 0));
