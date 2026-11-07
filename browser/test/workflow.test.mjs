// Static guards on .github/workflows/verify.yml (CLAUDE.md rule 4). Line-based on purpose: no YAML dependency,
// and the workflow is written in a plain block style these checks understand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const text = readFileSync(new URL("../../.github/workflows/verify.yml", import.meta.url), "utf8");
const lines = text.split("\n");

/** Top-level jobs: { name: string[] (the job's lines) }, in file order. */
function jobs() {
  const start = lines.indexOf("jobs:");
  assert.ok(start >= 0, "jobs: block");
  const out = {};
  let cur = null;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (m) {
      cur = m[1];
      out[cur] = [];
    } else if (/^\S/.test(line)) break;
    else if (cur) out[cur].push(line);
  }
  return out;
}

/** The bodies of every `run: |` block, without the YAML indentation. */
function runBlocks() {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== "|") {
      blocks.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

const J = jobs();

test("job order is validate -> browser -> tests, and there are no other jobs", () => {
  assert.deepEqual(Object.keys(J), ["validate", "browser", "tests"]);
  assert.ok(J.browser.some((l) => /^ {4}needs: validate$/.test(l)), "browser needs validate");
  assert.ok(J.tests.some((l) => /^ {4}needs: \[validate, browser\]$/.test(l)), "tests needs validate and browser");
  assert.ok(J.tests.some((l) => l.includes("if: ${{ !cancelled() && needs.validate.result == 'success' }}")), "tests: not after a cancel, only after validate passed");
});

test("every job has permissions: {} and a timeout; untrusted tests time out at 10 minutes", () => {
  assert.match(text, /^permissions: \{\}$/m);
  for (const [name, body] of Object.entries(J)) {
    assert.ok(body.some((l) => /^ {4}permissions: \{\}$/.test(l)), `${name}: permissions: {}`);
    assert.ok(body.some((l) => /^ {4}timeout-minutes: \d+$/.test(l)), `${name}: timeout-minutes`);
  }
  assert.ok(J.tests.some((l) => /^ {4}timeout-minutes: 10$/.test(l)));
});

test("no secrets anywhere, and no expression is interpolated inside a run: block", () => {
  const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n"); // comments may name what is absent
  assert.doesNotMatch(code, /secrets\b/);
  assert.doesNotMatch(code, /GITHUB_TOKEN|github\.token|ACTIONS_RUNTIME_TOKEN/);
  const blocks = runBlocks();
  assert.ok(blocks.length >= 6);
  for (const b of blocks) assert.ok(!b.includes("${{"), `run block interpolates an expression:\n${b}`);
});

test("inputs are exactly the five Arbiter dispatches, and the run name is the bare dispatch key", () => {
  const start = lines.findIndex((l) => l === "    inputs:");
  const names = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^ {6}([a-z0-9_]+):\s*$/.exec(l);
    if (m) names.push(m[1]);
    else if (/^ {0,4}\S/.test(l)) break;
  }
  assert.deepEqual(names.sort(), ["deploy_url", "plan_b64", "repo_url", "run_name", "sha"]);
  assert.match(text, /^run-name: \$\{\{ inputs\.run_name \}\}$/m);
});

test("only the browser job uploads, exactly one artifact, named arbiter-results; tests uses no actions", () => {
  assert.equal((text.match(/actions\/upload-artifact@/g) ?? []).length, 1);
  assert.equal((text.match(/^\s+name: arbiter-results$/gm) ?? []).length, 1);
  assert.ok(J.browser.some((l) => l.includes("actions/upload-artifact@v7")));
  // Arbiter reads this step's conclusion: success + no arbiter-results artifact means it was deleted (errored run).
  assert.equal(J.browser.filter((l) => /^ {6}- name: upload results$/.test(l)).length, 1);
  // ...which is only true if a successful upload step means the artifact existed: no files must fail the step.
  assert.equal(J.browser.filter((l) => /^ {10}if-no-files-found: error$/.test(l)).length, 1);
  assert.doesNotMatch(text, /if-no-files-found: (ignore|warn)/);
  assert.ok(!J.tests.some((l) => /\buses:/.test(l)), "tests job uses no actions");
  assert.ok(!J.validate.some((l) => /\buses:/.test(l)), "validate job uses no actions");
  assert.doesNotMatch(text, /actions\/checkout/);
});

test("untrusted code runs only in tests, under env -i; the browser job fetches only this repo at the workflow sha", () => {
  const bj = J.browser.join("\n");
  assert.doesNotMatch(bj, /REPO_URL|inputs\.repo_url|inputs\.sha/);
  assert.match(bj, /"\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY" "\$GITHUB_WORKFLOW_SHA"/);
  assert.match(bj, /npm ci --ignore-scripts/);
  const tj = J.tests.join("\n");
  assert.doesNotMatch(tj, /GITHUB_REPOSITORY|GITHUB_WORKFLOW_SHA|interp/);
  for (const cmd of ["npm ci", "npm test"]) assert.match(tj, new RegExp(`env -i PATH="\\$PATH" HOME="\\$HOME" CI=true ${cmd}`));
});

test("validate checks every input with the same patterns Arbiter uses, plus the plan length cap", () => {
  const vj = J.validate.join("\n");
  for (const re of [
    String.raw`repo_re='^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'`,
    "sha_re='^[0-9a-f]{40}$'",
    "url_re='^https://[A-Za-z0-9.-]+(/[!-~]*)?$'",
    "uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'",
    "b64_re='^[A-Za-z0-9+/]+={0,2}$'",
  ])
    assert.ok(vj.includes(re), re);
  for (const v of ["REPO_URL", "COMMIT_SHA", "DEPLOY_URL", "RUN_NAME", "PLAN_B64"]) assert.match(vj, new RegExp(`check \\w+ "\\$${v}"`));
  assert.match(vj, /"\$\{#PLAN_B64\}" -gt 60000/);
});

// Runs the real validate script (extracted from verify.yml) under bash with hostile inputs (Review Focus 1).
const validateScript = runBlocks()[0];
const good = {
  REPO_URL: "https://github.com/antonyjasfer/arbiter-demo-pass",
  COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  DEPLOY_URL: "https://arbiter-demo-pass.onrender.com/",
  RUN_NAME: "0f8fad5b-d9cb-469f-a165-70867728950e",
  PLAN_B64: Buffer.from('{"m1c1":{"kind":"review","steps":[]}}').toString("base64"),
};
function runValidate(over) {
  const r = spawnSync("bash", ["-c", validateScript], { env: { PATH: process.env.PATH, ...good, ...over }, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("validate script accepts good inputs and rejects injection attempts without echoing them", () => {
  assert.equal(validateScript.includes("inputs ok"), true);
  const ok = runValidate({});
  assert.equal(ok.code, 0, ok.out);
  const bad = [
    { REPO_URL: "https://github.com/a/b; curl evil" },
    { REPO_URL: "https://github.com/a/b\nhttps://github.com/c/d" },
    { REPO_URL: "https://gitlab.com/a/b" },
    { REPO_URL: "https://github.com/a/b/../c" },
    { COMMIT_SHA: `${good.COMMIT_SHA}\n` },
    { COMMIT_SHA: good.COMMIT_SHA.toUpperCase() },
    { COMMIT_SHA: "$(id)" },
    { DEPLOY_URL: "javascript:alert(1)" },
    { DEPLOY_URL: "http://169.254.169.254/latest/meta-data" },
    { DEPLOY_URL: "https://x.onrender.com/a b" },
    { DEPLOY_URL: "https://user@x.onrender.com/" },
    { RUN_NAME: "123" },
    { RUN_NAME: `${good.RUN_NAME} ` },
    { PLAN_B64: "eyJ9`id`" },
    { PLAN_B64: "A".repeat(60_004) },
  ];
  for (const over of bad) {
    const r = runValidate(over);
    assert.equal(r.code, 1, `accepted: ${JSON.stringify(over).slice(0, 120)}`);
    assert.match(r.out, /REJECTED/);
    const v = Object.values(over)[0];
    if (v.length > 6) assert.ok(!r.out.includes(v.trim()), "the rejected value is not echoed");
  }
});
