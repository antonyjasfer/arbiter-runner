// Mirrors arbiter web/src/server/verification/plan-dsl.test.ts: the runner re-validates every plan itself and
// fails closed, so a plan Arbiter's Zod schema would reject is never interpreted here either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEPS, validateCriterion, validatePlan, joinSitePath } from "../dsl.mjs";

const ok = (v) => validateCriterion(v).ok;

test("accepts each browser operation with its exact fields", () => {
  assert.equal(
    ok({
      kind: "browser",
      steps: [
        { op: "goto", path: "/" },
        { op: "fill_by_label", label: "New task", value: "Buy milk" },
        { op: "click_by_role", role: "button", name: "Add" },
        { op: "expect_text", text: "Buy milk" },
        { op: "click_by_role", role: "checkbox", name: "Buy milk" },
        { op: "expect_checkbox_checked", label: "Buy milk" },
        { op: "http_get", path: "/health", status: 200 },
        { op: "http_get", path: "/api/health", status: 200, json: { status: "ok", up: true, n: 1, extra: null } },
      ],
    }),
    true,
  );
  assert.equal(ok({ kind: "browser", steps: [{ op: "fill_by_label", label: "Note", value: "" }] }), true);
});

test("accepts the static operations, the test operation and an empty review plan", () => {
  assert.equal(
    ok({
      kind: "static",
      steps: [
        { op: "file_exists", path: "README.md" },
        { op: "file_contains", path: "docs/setup.md", text: "npm start" },
        { op: "package_script_exists", script: "test" },
      ],
    }),
    true,
  );
  assert.equal(ok({ kind: "test", steps: [{ op: "npm_test" }] }), true);
  assert.equal(ok({ kind: "review", steps: [] }), true);
});

test("rejects unknown operations, eval-like operations, CSS or XPath selector fields and extra fields", () => {
  assert.equal(ok({ kind: "browser", steps: [{ op: "evaluate", script: "1" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "eval", code: "alert(1)" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "click", selector: "#add" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "click_by_role", role: "button", name: "Add", selector: "//button" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "click_by_role", role: "iframe", name: "x" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "goto", path: "/", extra: 1 }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "goto", path: "/" }], extra: 1 }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "toString" }] }), false);
  assert.equal(ok({ kind: "constructor", steps: [] }), false);
});

test("rejects javascript: URLs and every absolute or protocol-relative URL; paths only", () => {
  for (const path of ["javascript:alert(1)", "https://evil.example/", "http://169.254.169.254/latest", "//evil.example/x", "/\\evil.example", "relative", "/a b", "/\nx", "/\u00e9"]) {
    assert.equal(ok({ kind: "browser", steps: [{ op: "goto", path }] }), false, path);
    assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path, status: 200 }] }), false, path);
  }
  assert.equal(ok({ kind: "browser", steps: [{ op: "goto", path: "/" + "a".repeat(499) }] }), true);
  assert.equal(ok({ kind: "browser", steps: [{ op: "goto", path: "/" + "a".repeat(500) }] }), false);
});

test("rejects more than 15 steps", () => {
  const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ op: "expect_text", text: "x" }));
  assert.equal(MAX_STEPS, 15);
  assert.equal(ok({ kind: "browser", steps }), false);
  assert.equal(ok({ kind: "browser", steps: steps.slice(0, 15) }), true);
});

test("rejects selectors over 200 characters, empty selectors and control characters", () => {
  assert.equal(ok({ kind: "browser", steps: [{ op: "expect_text", text: "x".repeat(201) }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "expect_text", text: "x".repeat(200) }] }), true);
  assert.equal(ok({ kind: "browser", steps: [{ op: "fill_by_label", label: "", value: "a" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "expect_text", text: "a\u0000b" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "expect_text", text: "a\u007fb" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "fill_by_label", label: "a", value: "v".repeat(501) }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "expect_text", text: 5 }] }), false);
});

test("gives review criteria no steps, and mixes no kinds", () => {
  assert.equal(ok({ kind: "review", steps: [{ op: "expect_text", text: "x" }] }), false);
  assert.equal(ok({ kind: "browser", steps: [] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "file_exists", path: "README.md" }] }), false);
  assert.equal(ok({ kind: "static", steps: [{ op: "goto", path: "/" }] }), false);
  assert.equal(ok({ kind: "test", steps: [{ op: "npm_test" }, { op: "npm_test" }] }), false);
  assert.equal(ok({ kind: "browser", steps: "goto /" }), false);
});

test("rejects repo paths that climb out or are absolute, and floats or nesting in JSON expectations", () => {
  for (const path of ["../secret", "a/../../b", "/etc/passwd", "C:\\x", ""]) {
    assert.equal(ok({ kind: "static", steps: [{ op: "file_exists", path }] }), false, path);
  }
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200, json: { v: 1.5 } }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200, json: { v: { nested: 1 } } }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200, json: { v: [1] } }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 600 }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200.5 }] }), false);
  const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200, json: eleven }] }), false);
  assert.equal(ok({ kind: "browser", steps: [{ op: "http_get", path: "/h", status: 200, json: { "": 1 } }] }), false);
});

test("a plan is keyed by criterion keys and fails closed as a whole", () => {
  const good = { m1c1: { kind: "browser", steps: [{ op: "goto", path: "/" }] }, m1c2: { kind: "review", steps: [] } };
  assert.equal(validatePlan(good).ok, true);
  assert.equal(validatePlan({ crit1: { kind: "review", steps: [] } }).ok, false);
  assert.equal(validatePlan({ ...good, m1c3: { kind: "browser", steps: [{ op: "eval", code: "1" }] } }).ok, false);
  assert.equal(validatePlan([good]).ok, false);
  assert.equal(validatePlan(null).ok, false);
  assert.equal(validatePlan(JSON.parse('{"__proto__": {"kind": "review", "steps": []}}')).ok, false);
  const bad = validatePlan({ m1c1: { kind: "browser", steps: [{ op: "goto", path: "/" }, { op: "nope" }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^m1c1\.steps\[1\]/);
  assert.match(bad.error, /^[ -~]{1,200}$/);
});

test("joinSitePath keeps every URL on the deploy origin", () => {
  assert.equal(joinSitePath("https://demo.onrender.com", "/api/health"), "https://demo.onrender.com/api/health");
  assert.equal(joinSitePath("https://demo.onrender.com/", "/x"), "https://demo.onrender.com/x");
  assert.equal(joinSitePath("https://demo.onrender.com/app", "/x"), "https://demo.onrender.com/app/x");
  assert.equal(joinSitePath("https://demo.onrender.com", "/@evil.example/x"), "https://demo.onrender.com/@evil.example/x");
  assert.equal(joinSitePath("https://demo.onrender.com", "/../../etc"), "https://demo.onrender.com/etc");
  assert.throws(() => joinSitePath("https://demo.onrender.com", "//evil.example"));
  assert.throws(() => joinSitePath("http://demo.onrender.com", "/"));
});
