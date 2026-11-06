# Runner fixtures (hostile repos)

Each folder is an overlay on the `pass` branch of the public fixture repo `antonyjasfer/arbiter-spike-fixture`
(Phase 1). `build-branches.mjs` turns them into branches of a local clone; pushing them is a separate, manual step.
Arbiter dispatches `verify.yml` with `repo_url` = that repo and `sha` = the pinned branch commit.

| Branch | What it does | Expected result |
|---|---|---|
| `malicious-postinstall` | A `postinstall` lists credential-shaped variable **names** it can see (its own environment and other processes' environments) and checks for credential files. A test prints "PASS: all acceptance criteria met" and then fails. | `npm ci` succeeds and the probe finds no Arbiter secret (there are none on the VM). The `tests` job **fails**: the verdict comes from the exit code, not the printed text. |
| `never-ending-test` | `npm test` never finishes. | The `tests` job is stopped by `timeout-minutes: 10`; the `test` criteria are not PASS. |
| `forged-results` | `npm test` looks for the runner's artifact runtime token (own env, other processes' env with `sudo -n`, runner files) and, if found, uploads an `arbiter-results` artifact that marks everything passed. If the name is taken it deletes the real artifact and uploads again. | Either every upload fails, or one succeeds and Arbiter marks the run errored (`unexpected_artifacts`: a second results artifact, or one created after the `tests` job started). No verdict is written either way. |

The probes print names, counts and yes/no only, never a value, because the run logs are public.
