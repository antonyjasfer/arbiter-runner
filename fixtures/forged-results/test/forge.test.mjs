// Runs as `npm test` in the untrusted `tests` job, after the trusted browser job has uploaded the real
// `arbiter-results`. Tries to replace it with a forged one. The test itself always passes, so the job's success
// cannot be what stops the forgery: Arbiter must reject the run from its artifact list (unexpected_artifacts).
// Logs names and outcomes only; any discovered value is redacted from error text.
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scan, redact } = require("../probe.js");

const forged = {
  version: 1,
  run_name: "00000000-0000-4000-8000-000000000000",
  plan_sha256: "0".repeat(64),
  plan_error: null,
  status: "ok",
  warmup: { ok: true, attempts: 1, ms: 0, status: 200 },
  criteria: Object.fromEntries(
    ["m1c1", "m1c2", "m1c3", "m1c4", "m1c5", "m1c6"].map((k) => [
      k,
      { status: "pass", failed_step: null, reason: null, steps: [{ index: 0, op: "goto", status: "pass", reason: null, ms: 1, actual_status: 200, mismatched_keys: [], screenshot: null }] },
    ]),
  ),
  screenshots_skipped: 0,
};

test("forged results: try to upload arbiter-results from untrusted code", { timeout: 240_000 }, async () => {
  const found = scan((l) => console.log(`[forge] ${l}`));
  const out = (msg) => console.log(`[forge] ${redact(msg, found)}`);
  if (!found.ACTIONS_RUNTIME_TOKEN || !found.ACTIONS_RESULTS_URL) {
    out(`outcome: no_token (runtime token found=${Boolean(found.ACTIONS_RUNTIME_TOKEN)}, results url found=${Boolean(found.ACTIONS_RESULTS_URL)}); no upload attempted`);
    return;
  }
  for (const n of ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_RUNTIME_URL"]) if (found[n]) process.env[n] = found[n].value;
  process.env.GITHUB_WORKSPACE ??= process.cwd();

  const dir = mkdtempSync(join(tmpdir(), "forged-"));
  const file = join(dir, "results.json");
  writeFileSync(file, JSON.stringify(forged, null, 2));

  const { DefaultArtifactClient } = await import("@actions/artifact");
  const client = new DefaultArtifactClient();
  const upload = async (label) => {
    try {
      const r = await client.uploadArtifact("arbiter-results", [file], dir, { retentionDays: 1 });
      out(`${label}: upload ok id=${r.id ?? "?"} size=${r.size ?? "?"}`);
      return true;
    } catch (e) {
      out(`${label}: upload failed ${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}`);
      return false;
    }
  };

  if (await upload("attempt 1 (same name)")) return out("outcome: uploaded_duplicate_name");
  try {
    const d = await client.deleteArtifact("arbiter-results");
    out(`delete real arbiter-results: ok id=${d.id ?? "?"}`);
  } catch (e) {
    out(`delete real arbiter-results: failed ${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (await upload("attempt 2 (after delete)")) return out("outcome: replaced_after_delete");
  out("outcome: all_uploads_failed");
});
