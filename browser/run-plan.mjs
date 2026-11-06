// Interprets a validated Arbiter check plan with Playwright against the deployed site and writes
// results.json (+ shots/N.jpg). Runs in the trusted `browser` job, before any freelancer code runs.
// It runs no repo code and evaluates no plan-supplied script. results.json holds only fixed reason codes,
// plan keys and numbers: no text from the site, so nothing a site renders can reach a verdict through it.
// Contract: arbiter web/src/server/verification/plan-dsl.ts (resultsSchema).
//
// Exit codes: 0 results written (checks may have failed: that is a verdict, not an error);
//             2 plan rejected (results.json says plan_invalid); 3 bad environment (no results written).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { joinSitePath, validatePlan } from "./dsl.mjs";

const RUN_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_PLAN_B64 = 60_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

export const DEFAULT_BUDGETS = {
  warmupMs: 90_000, // tolerate a Render Free cold start (~24 s measured, up to ~60 s)
  warmupIntervalMs: 5_000,
  attemptTimeoutMs: 15_000,
  stepTimeoutMs: 15_000,
  gotoTimeoutMs: 30_000,
  checksBudgetMs: 150_000, // all criteria together, after the warm-up
  maxShots: 20,
  shotMaxBytes: 300 * 1024,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StepFail extends Error {
  constructor(reason, extra = {}) {
    super(reason);
    this.reason = reason;
    this.extra = extra;
  }
}

function classify(e) {
  if (e instanceof StepFail) return e;
  const msg = String(e?.message ?? "");
  if (e?.name === "TimeoutError") return new StepFail("not_found");
  if (msg.includes("strict mode violation")) return new StepFail("ambiguous");
  return new StepFail("error");
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new StepFail("error");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GET that follows at most 5 redirects, and only within the deploy origin. */
async function getSameOrigin(url, origin, timeoutMs, fetchFn) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, current);
      await res.body?.cancel().catch(() => {});
      if (next.origin !== origin) throw new StepFail("origin_mismatch", { actual_status: res.status });
      current = next.href;
      continue;
    }
    return res;
  }
  throw new StepFail("error");
}

async function warmUp(url, origin, b, fetchFn, now) {
  const start = now();
  let attempts = 0;
  let status = null;
  while (attempts < 100) {
    attempts++;
    try {
      const res = await getSameOrigin(url, origin, Math.max(1, Math.min(b.attemptTimeoutMs, b.warmupMs - (now() - start))), fetchFn);
      status = res.status;
      await res.body?.cancel().catch(() => {});
      if (res.status < 500) return { ok: true, attempts, ms: now() - start, status };
    } catch (e) {
      if (e instanceof StepFail && e.reason === "origin_mismatch") return { ok: true, attempts, ms: now() - start, status: e.extra.actual_status };
    }
    if (now() - start + b.warmupIntervalMs >= b.warmupMs) break;
    await sleep(b.warmupIntervalMs);
  }
  return { ok: false, attempts, ms: now() - start, status };
}

async function runStep(step, ctx) {
  const { page, url, origin, timeout, gotoTimeout, fetchFn } = ctx;
  switch (step.op) {
    case "goto": {
      let res;
      try {
        res = await page.goto(url(step.path), { waitUntil: "load", timeout: gotoTimeout });
      } catch (e) {
        throw new StepFail(e?.name === "TimeoutError" ? "timeout" : "navigation_failed");
      }
      const status = res ? res.status() : null;
      if (status === null) throw new StepFail("navigation_failed");
      if (new URL(page.url()).origin !== origin) throw new StepFail("origin_mismatch", { actual_status: status });
      if (status >= 400) throw new StepFail("http_error", { actual_status: status });
      return { actual_status: status };
    }
    case "fill_by_label":
      await page.getByLabel(step.label).fill(step.value, { timeout });
      return {};
    case "click_by_role":
      await page.getByRole(step.role, { name: step.name }).click({ timeout });
      return {};
    case "expect_text":
      await page.getByText(step.text).first().waitFor({ state: "visible", timeout });
      return {};
    case "expect_checkbox_checked": {
      const box = page.getByLabel(step.label);
      const deadline = Date.now() + timeout;
      await box.waitFor({ state: "attached", timeout });
      for (;;) {
        if (await box.isChecked({ timeout: Math.max(1, deadline - Date.now()) })) return {};
        if (Date.now() >= deadline) throw new StepFail("not_checked");
        await sleep(100);
      }
    }
    case "http_get": {
      let res;
      try {
        res = await getSameOrigin(url(step.path), origin, timeout, fetchFn);
      } catch (e) {
        if (e instanceof StepFail) throw e;
        throw new StepFail(e?.name === "TimeoutError" ? "timeout" : "navigation_failed");
      }
      const actual_status = res.status;
      const body = await readCapped(res);
      if (actual_status !== step.status) throw new StepFail("status_mismatch", { actual_status });
      if (!step.json) return { actual_status };
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new StepFail("not_json", { actual_status });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new StepFail("not_json", { actual_status });
      const mismatched_keys = Object.keys(step.json).filter((k) => !Object.hasOwn(parsed, k) || parsed[k] !== step.json[k]);
      if (mismatched_keys.length) throw new StepFail("json_mismatch", { actual_status, mismatched_keys });
      return { actual_status };
    }
    default:
      throw new StepFail("error"); // unreachable: the plan was validated
  }
}

const stepRecord = (index, op, status, reason = null, extra = {}) => ({
  index,
  op,
  status,
  reason,
  ms: Math.round(extra.ms ?? 0),
  actual_status: extra.actual_status ?? null,
  mismatched_keys: extra.mismatched_keys ?? [],
  screenshot: null,
});

/**
 * Interprets every `browser` criterion of a validated plan; other kinds are Arbiter's job.
 * Writes outDir/results.json ({ ...header, status, warmup, criteria, screenshots_skipped }) and returns it.
 */
export async function runPlan({ plan, deployUrl, outDir, chromium, header = {}, budgets = {}, joinPath = joinSitePath, fetchFn = fetch, now = Date.now }) {
  const b = { ...DEFAULT_BUDGETS, ...budgets };
  const origin = new URL(deployUrl).origin;
  const url = (p) => {
    const u = joinPath(deployUrl, p);
    if (new URL(u).origin !== origin) throw new StepFail("origin_mismatch");
    return u;
  };
  mkdirSync(join(outDir, "shots"), { recursive: true });
  const keys = Object.keys(plan).filter((k) => plan[k].kind === "browser");
  const criteria = {};
  let shots = 0;
  let skippedShots = 0;

  const warmup = keys.length ? await warmUp(url("/"), origin, b, fetchFn, now) : { ok: true, attempts: 0, ms: 0, status: null };
  let status = "ok";
  if (!warmup.ok) {
    status = "site_unreachable";
    for (const k of keys) criteria[k] = { status: "error", failed_step: null, reason: "site_unreachable", steps: [] };
  } else {
    const browser = await chromium.launch({ headless: true });
    const deadline = now() + b.checksBudgetMs;
    try {
      for (const key of keys) {
        const steps = plan[key].steps;
        const record = [];
        let result = null;
        let context;
        try {
          context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false, serviceWorkers: "block" });
          const page = await context.newPage();
          page.on("dialog", (d) => d.dismiss().catch(() => {}));
          for (let i = 0; i < steps.length; i++) {
            const remaining = deadline - now();
            if (remaining <= 0) {
              result = { status: "error", failed_step: null, reason: "budget_exhausted" };
              break;
            }
            const t0 = now();
            try {
              const extra = await runStep(steps[i], {
                page,
                url,
                origin,
                fetchFn,
                timeout: Math.max(1, Math.min(b.stepTimeoutMs, remaining)),
                gotoTimeout: Math.max(1, Math.min(b.gotoTimeoutMs, remaining)),
              });
              record.push(stepRecord(i, steps[i].op, "pass", null, { ...extra, ms: now() - t0 }));
            } catch (e) {
              const f = classify(e);
              record.push(stepRecord(i, steps[i].op, "fail", f.reason, { ...f.extra, ms: now() - t0 }));
              result = { status: "fail", failed_step: i, reason: f.reason };
              break;
            }
          }
          // One screenshot per criterion, on its last executed step, if the page ever left about:blank.
          const last = record.at(-1);
          if (last && page.url() !== "about:blank") {
            if (shots >= b.maxShots) skippedShots++;
            else {
              let img = await page.screenshot({ type: "jpeg", quality: 60, timeout: 10_000 }).catch(() => null);
              if (img && img.byteLength > b.shotMaxBytes) img = await page.screenshot({ type: "jpeg", quality: 25, timeout: 10_000 }).catch(() => null);
              if (img && img.byteLength <= b.shotMaxBytes) {
                const name = `shots/${shots++}.jpg`;
                writeFileSync(join(outDir, name), img);
                last.screenshot = name;
              } else skippedShots++;
            }
          }
        } catch {
          result = { status: "error", failed_step: null, reason: "error" };
        } finally {
          await context?.close().catch(() => {});
        }
        for (let i = record.length; i < steps.length; i++) record.push(stepRecord(i, steps[i].op, "skipped"));
        criteria[key] = { ...(result ?? { status: "pass", failed_step: null, reason: null }), steps: record };
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const doc = { ...header, status, warmup, criteria, screenshots_skipped: skippedShots };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(doc, null, 2));
  return doc;
}

/** CLI entry: reads PLAN_B64, DEPLOY_URL, RUN_NAME and OUT_DIR from the environment. Returns the exit code. */
export async function main(env, deps = {}) {
  const runName = env.RUN_NAME ?? "";
  const planB64 = env.PLAN_B64 ?? "";
  let deploy;
  try {
    deploy = new URL(env.DEPLOY_URL ?? "");
  } catch {
    deploy = null;
  }
  if (!RUN_NAME.test(runName) || !deploy || deploy.protocol !== "https:" || !B64.test(planB64) || planB64.length > MAX_PLAN_B64) {
    console.error("run-plan: invalid environment (values not printed)");
    return 3;
  }
  const bytes = Buffer.from(planB64, "base64");
  const header = { version: 1, run_name: runName, plan_sha256: createHash("sha256").update(bytes).digest("hex"), plan_error: null };
  const outDir = env.OUT_DIR || "out";
  mkdirSync(join(outDir, "shots"), { recursive: true });

  let plan;
  let planError = null;
  try {
    plan = JSON.parse(bytes.toString("utf8"));
    const v = validatePlan(plan);
    if (!v.ok) planError = v.error;
  } catch {
    planError = "plan: not JSON";
  }
  if (planError) {
    const doc = { ...header, plan_error: planError, status: "plan_invalid", warmup: { ok: false, attempts: 0, ms: 0, status: null }, criteria: {}, screenshots_skipped: 0 };
    writeFileSync(join(outDir, "results.json"), JSON.stringify(doc, null, 2));
    console.error(`run-plan: plan rejected: ${planError}`);
    return 2;
  }

  const chromium = deps.chromium ?? (await import("playwright")).chromium;
  const doc = await runPlan({ plan, deployUrl: deploy.href, outDir, chromium, header });
  console.log(`run-plan: status=${doc.status} warmup_ok=${doc.warmup.ok} attempts=${doc.warmup.attempts}`);
  for (const [k, c] of Object.entries(doc.criteria)) console.log(`  ${k} ${c.status}${c.failed_step === null ? "" : ` step=${c.failed_step}`}${c.reason ? ` reason=${c.reason}` : ""}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.env);
}
