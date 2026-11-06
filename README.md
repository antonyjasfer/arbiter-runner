# arbiter-runner

Public repository that runs Arbiter's verification workflow (`.github/workflows/verify.yml`). It holds **no secrets** and no application code; `browser/` is the check-plan interpreter, `fixtures/` the hostile test repos.

How it is used: Arbiter's server starts a run with `workflow_dispatch` (inputs: `repo_url`, `sha`, `deploy_url`, `run_name`, `plan_b64`) using a fine-grained token that has Actions read/write on this repository only; that token never reaches the runner. The run is named after `run_name` (a UUID), which is how Arbiter finds it. Arbiter then reads the job and step conclusions from the GitHub API, downloads the `arbiter-results` artifact, and links the public run log as evidence.

Jobs, in order:

1. `validate` checks every input against a fixed pattern (github.com repo URL, 40-hex SHA, https deploy URL, UUID, base64 plan of at most 60,000 characters). Nothing else runs if it fails.
2. `browser` (trusted, runs no freelancer code) fetches this repository at the workflow's own commit, interprets the check plan with Playwright against the deployed site (`browser/run-plan.mjs`; the plan is a restricted DSL, never code), and uploads `results.json` and screenshots as the single artifact `arbiter-results`.
3. `tests` (untrusted) starts only after `browser` has finished. It fetches the freelancer repo at the pinned SHA and runs `npm ci` and `npm test` under `env -i`, with a 10-minute timeout. It uploads nothing; its verdict is the job's conclusion.

Honest limits:

- GitHub-hosted runners have **open internet egress**. There is no network allow-list. Mitigations: fresh VM per run, **no secret exists in any job** (`permissions: {}` everywhere), 10-minute timeouts, public repositories only. Assume the test VM is fully compromised by the repo under test: the runner user has `sudo` and can read process environments, so `env -i` is not a security control.
- Code in the `tests` job may be able to reach the runner's artifact runtime token and upload or delete artifacts. That is why `browser` runs first, and why Arbiter rejects a run (`unexpected_artifacts`) that has any artifact other than one `arbiter-results` created before the `tests` job started. `fixtures/forged-results` tests this.
- Run logs in a public repository are public. Output from the `tests` job is freelancer-controlled and untrusted.
- A check that redirects off the deploy origin fails (`origin_mismatch`), but its screenshot may still show the other site. Screenshots are public and show whatever the deployed site renders.
- Chromium runs without its sandbox (Playwright's default on the runner) while it renders the freelancer's site, and the same VM writes the trusted `arbiter-results`. A Chromium exploit served by the deployed site (a browser 0-day) could therefore forge results. Fresh VMs and a current Playwright reduce this; they do not remove it.
- Inputs are validated by the first job and are never interpolated into shell commands.

See [fixtures/README.md](fixtures/README.md) for the hostile repos used to test these limits.
