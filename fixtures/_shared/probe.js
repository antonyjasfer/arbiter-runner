// Hostile-repo probe for the Arbiter runner. Looks for credentials the way a malicious repo would, and reports
// NAMES, counts and yes/no only: the run log is public, so no value is ever printed.
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");

const CRED = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE/i;
const WANTED = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_RUNTIME_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN"];

function parseEnviron(buf) {
  const out = {};
  for (const kv of buf.toString("utf8").split("\0")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

function readEnviron(pid) {
  try {
    return { env: parseEnviron(readFileSync(`/proc/${pid}/environ`)), via: "read" };
  } catch {}
  try {
    const buf = execFileSync("sudo", ["-n", "cat", `/proc/${pid}/environ`], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    return { env: parseEnviron(buf), via: "sudo" };
  } catch {
    return null;
  }
}

function comm(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return "?";
  }
}

/** Scans the own environment and every process environment. Returns found values in memory (never printed). */
function scan(log = console.log) {
  const found = {}; // name -> { value, source }
  const own = Object.keys(process.env).filter((n) => CRED.test(n));
  log(`probe: own env credential-shaped names: ${JSON.stringify(own)}`);
  for (const n of WANTED) if (process.env[n]) found[n] = { value: process.env[n], source: "own env" };

  let pids = [];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  } catch {}
  let readable = 0;
  let viaSudo = 0;
  const hits = {}; // name -> Set of process names
  for (const pid of pids) {
    const r = readEnviron(pid);
    if (!r) continue;
    readable++;
    if (r.via === "sudo") viaSudo++;
    for (const [n, v] of Object.entries(r.env)) {
      if (!CRED.test(n) || !v) continue;
      (hits[n] ??= new Set()).add(comm(pid));
      if (WANTED.includes(n) && !found[n]) found[n] = { value: v, source: `env of ${comm(pid)}` };
    }
  }
  log(`probe: processes=${pids.length} environ readable=${readable} (via sudo ${viaSudo})`);
  for (const [n, s] of Object.entries(hits)) log(`probe: other-process credential-shaped name ${n} in [${[...s].join(", ")}]`);

  for (const f of [`${process.env.HOME ?? "/home/runner"}/.git-credentials`, "/home/runner/.git-credentials", "/home/runner/.npmrc", "/home/runner/.docker/config.json"]) {
    log(`probe: file ${f} exists=${existsSync(f)}`);
  }
  let runnerFiles = [];
  try {
    const out = execFileSync("sudo", ["-n", "grep", "-rlI", "--max-count=1", "ACTIONS_RUNTIME_TOKEN", "/home/runner/work/_temp", "/home/runner/runners", "/home/runner/actions-runner"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30000,
    });
    runnerFiles = out.toString("utf8").split("\n").filter(Boolean);
  } catch (e) {
    if (e && e.stdout) runnerFiles = e.stdout.toString("utf8").split("\n").filter(Boolean);
  }
  log(`probe: runner files mentioning ACTIONS_RUNTIME_TOKEN: ${runnerFiles.length}${runnerFiles.length ? ` (${runnerFiles.slice(0, 5).join(", ")})` : ""}`);
  for (const n of WANTED) log(`probe: ${n} found=${Boolean(found[n])}${found[n] ? ` source=${found[n].source}` : ""}`);
  return found;
}

/** Removes every found value from a string (for error messages). */
function redact(text, found) {
  let s = String(text);
  for (const { value } of Object.values(found)) if (value && value.length >= 8) s = s.split(value).join("[redacted]");
  return s
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1?[redacted-query]"); // signed blob URLs carry SAS tokens
}

module.exports = { scan, redact };
