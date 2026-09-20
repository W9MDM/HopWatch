import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Version + git commit shown in the footer, the profile menu, and at /api/version (fixes Malla #49).
let cachedVersion: string | null = null;
let cachedCommit: string | null = null;

export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8"));
    cachedVersion = String(pkg.version ?? "0.0.0");
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

// Resolve the deployed commit so the UI can show which build is actually running. Prefers a
// build-time env (HOPWATCH_GIT_COMMIT), else reads .git under the process working directory
// (npm start/worker run from the repo root), handling symbolic HEAD, packed-refs, and detached.
export function gitCommit(): string {
  if (cachedCommit) return cachedCommit;
  const env = process.env.HOPWATCH_GIT_COMMIT;
  if (env) return (cachedCommit = env.slice(0, 12));
  try {
    const root = process.cwd();
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      try {
        return (cachedCommit = readFileSync(join(root, ".git", ref), "utf8").trim().slice(0, 7));
      } catch {
        const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
        const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
        if (line) return (cachedCommit = line.slice(0, 7));
      }
    } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
      return (cachedCommit = head.slice(0, 7)); // detached HEAD
    }
  } catch { /* no .git available: fall through */ }
  return (cachedCommit = "dev");
}

export function versionInfo() {
  return { name: "HopWatch", version: appVersion(), commit: gitCommit() };
}
