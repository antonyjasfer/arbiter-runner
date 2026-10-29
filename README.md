# arbiter-runner

Public repository that runs Arbiter's verification workflow (`.github/workflows/verify.yml`). It contains **no application code and no secrets that matter**.

How it is used: Arbiter's server starts a run with `workflow_dispatch` (inputs: `repo_url`, `commit_sha`, `run_id`, `deploy_url`) using a fine-grained token that has Actions read/write on this repository only. It then reads the run's job and step conclusions from the GitHub API and links the public run log as evidence.

Honest limits:

- GitHub-hosted runners have **open internet egress**. There is no network allow-list. Mitigations: fresh VM per run, **no secret exists in any job that touches untrusted code** (`permissions: {}`), 10-minute timeouts, public repositories only. Assume the test VM is fully compromised by the repo under test: the runner user has `sudo` and can read process environments, so `env -i` is not a security control.
- Run logs in a public repository are public.
- Output from the `tests` job is freelancer-controlled and untrusted; the job uploads no artifacts. Chromium runs unsandboxed and follows redirects, so the screenshot artifact may show wherever a URL redirects.
- Inputs are validated by the first job and are never interpolated into shell commands.

The `SPIKE_CANARY` repository secret exists only during the Phase 1 spike to prove untrusted jobs cannot see secrets. The production runner holds no secrets at all.
