// The check-plan DSL, re-validated by the runner. It mirrors Arbiter's Zod schema
// (arbiter web/src/server/verification/plan-dsl.ts) rule for rule and fails closed: one bad criterion
// rejects the whole plan, and nothing in a rejected plan is interpreted. A plan is data, never code:
// no selectors, no script evaluation, no absolute URLs. No dependencies, so it can be tested anywhere.

export const MAX_STEPS = 15;
export const CRITERION_KEY = /^m\d{1,3}c\d{1,3}$/;
export const ROLES = ["button", "link", "checkbox", "textbox", "heading", "tab", "menuitem", "option", "radio", "switch"];

const NO_CONTROL = /^[^\u0000-\u001F\u007F]*$/;
const SITE_PATH = /^\/(?![/\\])[!-[\]-~]*$/;
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/;
const SCRIPT_NAME = /^[A-Za-z0-9:._-]{1,50}$/;

class PlanError extends Error {}
const fail = (where, what) => {
  throw new PlanError(`${where}: ${what}`.slice(0, 200));
};

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function exactKeys(v, where, required, optional = []) {
  if (!isPlainObject(v)) fail(where, "not an object");
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) fail(where, "unexpected field");
  for (const k of required) if (!Object.hasOwn(v, k)) fail(where, "missing field");
}

const str = (v, where, { min = 0, max, re }) => {
  if (typeof v !== "string" || v.length < min || v.length > max || (re && !re.test(v))) fail(where, "invalid text");
};
const selectorText = (v, where) => str(v, where, { min: 1, max: 200, re: NO_CONTROL });
const valueText = (v, where) => str(v, where, { max: 500, re: NO_CONTROL });
const sitePath = (v, where) => str(v, where, { max: 500, re: SITE_PATH });
const repoPath = (v, where) => str(v, where, { min: 1, max: 200, re: REPO_PATH });
const isInt = (v, min, max) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function jsonExpectation(v, where) {
  if (!isPlainObject(v)) fail(where, "not an object");
  const keys = Object.keys(v);
  if (keys.length > 10) fail(where, "at most 10 keys");
  for (const k of keys) {
    if (k.length < 1 || k.length > 100) fail(where, "invalid key");
    const x = v[k];
    const scalar = x === null || typeof x === "boolean" || isInt(x, -1e9, 1e9) || (typeof x === "string" && x.length <= 200);
    if (!scalar) fail(where, "values are strings, booleans, integers or null");
  }
}

const BROWSER = {
  goto: (s, w) => (exactKeys(s, w, ["op", "path"]), sitePath(s.path, `${w}.path`)),
  fill_by_label: (s, w) => (exactKeys(s, w, ["op", "label", "value"]), selectorText(s.label, `${w}.label`), valueText(s.value, `${w}.value`)),
  click_by_role: (s, w) => {
    exactKeys(s, w, ["op", "role", "name"]);
    if (!ROLES.includes(s.role)) fail(`${w}.role`, "unknown role");
    selectorText(s.name, `${w}.name`);
  },
  expect_text: (s, w) => (exactKeys(s, w, ["op", "text"]), selectorText(s.text, `${w}.text`)),
  expect_checkbox_checked: (s, w) => (exactKeys(s, w, ["op", "label"]), selectorText(s.label, `${w}.label`)),
  http_get: (s, w) => {
    exactKeys(s, w, ["op", "path", "status"], ["json"]);
    sitePath(s.path, `${w}.path`);
    if (!isInt(s.status, 100, 599)) fail(`${w}.status`, "invalid status");
    if (Object.hasOwn(s, "json")) jsonExpectation(s.json, `${w}.json`);
  },
};
const STATIC = {
  file_exists: (s, w) => (exactKeys(s, w, ["op", "path"]), repoPath(s.path, `${w}.path`)),
  file_contains: (s, w) => (exactKeys(s, w, ["op", "path", "text"]), repoPath(s.path, `${w}.path`), selectorText(s.text, `${w}.text`)),
  package_script_exists: (s, w) => (exactKeys(s, w, ["op", "script"]), str(s.script, `${w}.script`, { max: 50, re: SCRIPT_NAME })),
};
const TEST = { npm_test: (s, w) => exactKeys(s, w, ["op"]) };

function steps(c, where, ops, { min, max }) {
  if (!Array.isArray(c.steps) || c.steps.length < min || c.steps.length > max) fail(`${where}.steps`, "wrong number of steps");
  c.steps.forEach((s, i) => {
    const w = `${where}.steps[${i}]`;
    const op = isPlainObject(s) && typeof s.op === "string" && Object.hasOwn(ops, s.op) ? ops[s.op] : null;
    if (!op) fail(w, "operation not allowed for this kind");
    op(s, w);
  });
}

function checkCriterion(c, where) {
  exactKeys(c, where, ["kind", "steps"]);
  switch (c.kind) {
    case "test":
      return steps(c, where, TEST, { min: 1, max: 1 });
    case "static":
      return steps(c, where, STATIC, { min: 1, max: MAX_STEPS });
    case "browser":
      return steps(c, where, BROWSER, { min: 1, max: MAX_STEPS });
    case "review":
      return steps(c, where, {}, { min: 0, max: 0 });
    default:
      return fail(where, "unknown kind");
  }
}

const wrap = (fn) => {
  try {
    fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof PlanError) return { ok: false, error: e.message };
    throw e;
  }
};

/** One criterion's plan. */
export const validateCriterion = (c) => wrap(() => checkCriterion(c, "criterion"));

/** A whole plan: { [criterionKey]: criterionPlan }. Any bad criterion rejects the whole plan. */
export function validatePlan(plan) {
  const r = wrap(() => {
    if (!isPlainObject(plan)) fail("plan", "not an object");
    for (const key of Object.keys(plan)) {
      if (!CRITERION_KEY.test(key)) fail("plan", "invalid criterion key");
      checkCriterion(plan[key], key);
    }
  });
  return r.ok ? { ok: true, plan } : r;
}

/** deploy_url + a validated site path, refusing anything that leaves the deploy origin. */
export function joinSitePath(deployUrl, path) {
  const base = new URL(deployUrl);
  if (base.protocol !== "https:") throw new Error("deploy_url must be https");
  if (typeof path !== "string" || !SITE_PATH.test(path) || path.length > 500) throw new Error("invalid site path");
  const url = new URL(base.origin + base.pathname.replace(/\/+$/, "") + path);
  if (url.origin !== base.origin) throw new Error("path leaves the deploy origin");
  return url.href;
}
