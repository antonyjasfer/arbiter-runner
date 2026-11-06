// Adds the hostile fixture branches to a LOCAL clone of antonyjasfer/arbiter-spike-fixture. Never pushes.
// Usage: node build-branches.mjs <path-to-clone>   (the clone must have a clean `pass` branch)
// Each branch = `pass` + the files of fixtures/<branch>/ + fixtures/_shared/probe.js (where it is used).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = process.argv[2] ? resolve(process.argv[2]) : null;
if (!repo || !existsSync(join(repo, ".git"))) throw new Error("usage: node build-branches.mjs <path-to-clone>");

const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
if (git("status", "--porcelain")) throw new Error("clone has uncommitted changes");
git("checkout", "-q", "pass");

const BRANCHES = { "malicious-postinstall": true, "never-ending-test": false, "forged-results": true }; // value: needs probe.js
for (const [branch, probe] of Object.entries(BRANCHES)) {
  git("checkout", "-q", "-B", branch, "pass");
  cpSync(join(here, branch), repo, { recursive: true });
  if (probe) cpSync(join(here, "_shared", "probe.js"), join(repo, "probe.js"));
  git("add", "-A");
  git("-c", "user.name=arbiter-fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", `${branch}: hostile runner fixture (see arbiter-runner/fixtures/README.md)`);
  console.log(`${branch} ${git("rev-parse", "HEAD")}`);
}
git("checkout", "-q", "pass");
