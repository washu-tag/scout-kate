# CI Security Scanning

Scout's CI pipeline includes several layers of automated security scanning. This document describes each tool, what it does, how findings surface, and how to tune the configuration when scanners are too noisy or too quiet.

## Overview

| Tool | What it scans | Workflow file | Blocks PRs? | Findings visible in |
|---|---|---|---|---|
| **CodeQL** (`security-extended`) | Source code (JS/TS, Python, Java, Actions) | `codeql.yml` | Yes | Security tab > Code scanning |
| **Trivy image scan** | Container images built in CI | `ci.yaml` (scan-images job) | Yes (fixable CRITICAL/HIGH only) | Security tab > Code scanning |
| **Trivy repo scan** | Dependency lockfiles in the repo | `security.yaml` | Yes (CRITICAL only) | Workflow logs |
| **Semgrep** | K8s, YAML, Dockerfiles, secrets, OWASP | `security.yaml` | Yes (new findings only, via Code Scanning) | Security tab > Code scanning |
| **Dependency review** | New dependencies introduced in a PR | `dependency-review.yaml` | Yes (critical vulns only) | PR comment |
| **Dependabot** | GitHub Actions version updates | `dependabot.yml` | N/A (opens PRs) | Pull requests |

## Files

```
.github/
├── actions/
│   └── trivy-scan-image/
│       └── action.yaml          # Composite action: download artifact → Trivy scan → SARIF upload → gate
├── workflows/
│   ├── ci.yaml                  # build-and-upload + scan-images matrices, publish gated on scans
│   ├── codeql.yml               # CodeQL with security-extended queries
│   ├── dependency-review.yaml   # GitHub-native dependency diff on PRs
│   └── security.yaml            # Trivy repo scan + Semgrep
├── dependabot.yml               # GitHub Actions version update PRs
trivy.yaml                       # Trivy config (points to ignore file)
.trivyignore.yaml                # Suppressed CVEs for Trivy (supports path-specific ignores)
.semgrepignore                   # Excluded paths for Semgrep
```

## Prerequisites

### CodeQL: disable default setup

The `codeql.yml` workflow is an "advanced setup". If the repository also has CodeQL's **default setup** enabled in the GitHub UI, SARIF uploads will fail with: _"CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled"_.

To fix: **Settings > Code security > Code scanning > CodeQL analysis** — switch from "Default" to "Not set".

### GitHub Advanced Security (private repos)

Third-party SARIF uploads (Trivy, Semgrep) require **GitHub Advanced Security** to be enabled for private repos. Without it, uploads succeed silently but findings don't appear in the Security tab. CodeQL is exempt since it's GitHub-native.

Check: **Settings > Code security > GitHub Advanced Security**.

### Rulesets: require status checks and code scanning results

The repository ruleset for `main` (**Settings > Rules > Rulesets**) has two complementary sections that work together:

**Require status checks to pass** ensures the CI jobs actually ran successfully. **Require code scanning results** inspects the SARIF findings and blocks only if a PR introduces *new* alerts above a severity threshold. You want both — the status check catches job failures (crashes, timeouts), while code scanning results evaluates what was found.

#### Status checks

Under **Require status checks to pass**, add the workflow job names:

| Check name | Source | What it catches |
|---|---|---|
| `deploy-and-test` | `ci.yaml` | Build/test failures (already present) |
| `CodeQL` | `codeql.yml` | CodeQL analysis failures (already present) |
| `Security Scanning / semgrep` | `security.yaml` | Semgrep job crash or config error |
| `Security Scanning / trivy-repo-scan` | `security.yaml` | Trivy repo scan failure (also gates via exit-code on CRITICAL vulns) |
| `scan-images` | `ci.yaml` | Trivy image scan job failures |
| `Dependency Review / dependency-review` | `dependency-review.yaml` | Dependency review failure (also gates via exit-code on critical vulns) |

#### Code scanning results

Under **Require code scanning results**, click **+ Add tool** for each SARIF-uploading scanner:

| Tool | Security alerts | Alerts |
|---|---|---|
| **CodeQL** | High or higher | Errors |
| **Semgrep** | High or higher | Errors |
| **Trivy** | High or higher | Errors |

Each tool has two threshold dropdowns:

- **Security alerts** — vulnerability severity: `None`, `Critical`, `High or higher`, `Medium or higher`, `All`
- **Alerts** — general code quality: `None`, `Errors`, `Errors and Warnings`, `All`

Tools appear in the dropdown after their first SARIF upload to the repository. If a tool doesn't appear yet, merge this PR first, then add it.

Note: Trivy image scanning uploads SARIF per image (categories `trivy-hl7log-extractor`, `trivy-launchpad`, etc.). The tool may appear as a single "Trivy" entry or per-category — add whichever appears in the dropdown.

The Trivy repo scan (`security.yaml`) and dependency review action don't upload SARIF — they gate directly via `exit-code` under the status checks section above.

#### Why different gating approaches?

| Scanner | Gating | Why |
|---|---|---|
| **CodeQL, Semgrep** | SARIF (code scanning results) | Findings are in source code — diff-aware gating prevents pre-existing issues from blocking unrelated PRs |
| **Trivy image scan** | SARIF + exit-code on fixable | Findings visible in Security tab; exit-code gates on fixable vulns only |
| **Trivy repo scan** | Exit-code only | Scans dependency lockfiles. Exit-code blocks on *any* critical CVE, even newly disclosed ones against existing dependencies. SARIF diff-aware gating would miss these since they also exist on `main` |
| **Dependency review** | Exit-code only | Already diff-aware by design (only examines deps added/changed in the PR). Also posts PR comments with license info, which SARIF doesn't support |

## How each scanner works

### CodeQL (`security-extended`)

CodeQL runs GitHub's static analysis on push to `main`, PRs to `main`, and weekly. The `security-extended` query pack adds ~135 security queries covering 35 additional CWEs beyond the default set, with minimal false positives. It covers JavaScript/TypeScript, Python, Java/Kotlin, and GitHub Actions.

**Configuration**: `.github/workflows/codeql.yml`, line with `queries: security-extended`.

### Trivy image scanning

A separate `scan-images` matrix job in `ci.yaml` runs **in parallel** with `deploy-and-test`, both triggered after `build-and-upload` completes. This keeps scanning off the critical path.

```
build-and-upload (20m) ──→ scan-images (~2m, parallel) ──→ publish
                        └──→ deploy-and-test (20m)      ──┘
```

Each matrix entry attempts to download the image tarball artifact. If the image wasn't rebuilt (no file changes and image already in registry), the download is skipped gracefully and the scan is a no-op.

The composite action (`.github/actions/trivy-scan-image/action.yaml`) does a single Trivy invocation per image:

1. **Single JSON scan** — Trivy scans once, outputting JSON. The Trivy DB is cached automatically by the trivy-action.
2. **SARIF conversion** — `trivy convert` produces SARIF from the JSON, which is uploaded to the GitHub Security tab for visibility.
3. **Gate check** — a shell step parses the JSON for fixable vulnerabilities and fails the job if any exist at CRITICAL or HIGH severity.

The `publish` and `publish-demo` jobs require `scan-images` in their `needs:` array, so a failed scan blocks publishing. Skipped scans (via `!cancelled()`) don't block it.

All third-party action references are pinned to commit hashes (not tags) to prevent supply chain attacks. Dependabot's `github-actions` ecosystem keeps these pins current.

**Images scanned**: `hl7log-extractor`, `hl7-transformer`, `pyspark-notebook`, `embedding-notebook`, `launchpad`, `superset`, `keycloak`.

### Trivy repo scanning

The `security.yaml` workflow runs Trivy in filesystem mode (`scanners: vuln`) against the entire repository, checking dependency lockfiles for known CVEs. Blocks PRs on CRITICAL severity findings.

IaC misconfiguration scanning (Dockerfiles, Helm, K8s YAML) is handled by Semgrep rather than Trivy, since Semgrep handles template syntax (Helm Go templates, Ansible Jinja2) better than Trivy's misconfig scanner, which parses raw files and produces false positives on unrendered templates.

Trivy image scanning and repo scanning are **complementary**, not redundant: image scanning catches OS-level packages in base images (apt, apk) that repo scanning doesn't see, while repo scanning catches dependencies across the whole repo (including code that doesn't get containerized).

### Semgrep

Runs in the `security.yaml` workflow inside the official `semgrep/semgrep` container (version-pinned to avoid unexpected breakage from `latest`). Current rule packs:

- `p/default` — general security rules
- `p/secrets` — hardcoded credentials, API keys
- `p/docker` — Dockerfile best practices
- `p/kubernetes` — Kubernetes manifest rules
- `p/owasp-top-ten` — OWASP Top 10 coverage

Semgrep runs once in SARIF mode (`--sarif --output semgrep.sarif`). A follow-up step parses the SARIF with `jq` to print a human-readable summary of findings to the workflow log. The SARIF is uploaded to GitHub's Security tab, which handles diff-aware gating — only findings *new* in a PR block the merge (via the "Code scanning results / semgrep" status check), not pre-existing ones. This requires the check to be set as required in **Settings > Branches > Branch protection rules**.

### Dependency review

The `dependency-review.yaml` workflow uses GitHub's first-party `actions/dependency-review-action`. On every PR, it diffs the dependency graph between the base and head commits and blocks the PR if any new dependency introduces a known critical vulnerability. It also posts a summary comment on every PR (`comment-summary-in-pr: always`) including license information for new dependencies.

This only reviews **newly added or changed** dependencies — existing dependencies are not flagged.

### Dependabot

Configured in `.github/dependabot.yml` for **GitHub Actions version updates only** (weekly). This keeps pinned action commit hashes current.

Dependency vulnerability alerts (npm, pip, gradle, Docker base images) are handled separately via **Dependabot security updates** enabled in the GitHub UI, which only opens PRs when a known CVE is found — not for every new version.

## Reviewing findings

### In the GitHub Security tab

All SARIF-based scanners (CodeQL, Trivy, Semgrep) report to **Security tab > Code scanning alerts**, filterable by tool name.

**Important**: The Security tab defaults to showing findings for the `main` branch. To see findings from a PR branch, use the branch dropdown filter.

Useful filters in the code scanning alerts view:

- `is:open` — all open findings (default)
- `tool:semgrep` — findings from Semgrep only
- `tool:trivy` — findings from Trivy only
- `pr:123` — findings introduced in a specific PR
- `is:open tool:semgrep pr:123` — combine filters to narrow results

To dismiss a finding, click into it and select **Dismiss alert** with a reason (false positive, won't fix, or used in tests). Dismissals persist across future runs.

### In workflow logs

Each scanner also prints findings directly in the GitHub Actions workflow log:

- **Trivy image scan**: The gate step prints a table of fixable vulnerabilities (severity, CVE ID, package, installed vs. fixed version).
- **Trivy repo scan** (vuln): Prints a table directly (uses `format: 'table'`).
- **Semgrep**: A `jq` step prints each finding's level, file:line, rule ID, and message excerpt.
- **CodeQL**: Findings appear in the "Perform CodeQL Analysis" step output.

To view: go to the workflow run in the **Actions tab**, click the relevant job, and expand the step.

## Triaging findings

When scanners are first enabled, expect a large initial set of findings from pre-existing code. These are not regressions — the scanners are making existing issues visible.

**Recommended approach:**

1. **Triage by rule, not by file** — sort by rule ID in the Security tab. A handful of rules typically produce most findings. Fixing the pattern is faster than fixing files individually.
2. **Prioritize by severity** — fix CRITICAL/HIGH first, track MEDIUM in the backlog.
3. **Dismiss false positives** — use "Dismiss" with a reason in the Security tab. This persists across runs.
4. **Don't block the initial merge** — the PR-level checks prevent regressions. The existing findings are tracked in the Security tab and can be addressed over time.

## Tuning and common modifications

### Suppressing a Trivy CVE

Add entries to `.trivyignore.yaml` in the repository root. The YAML format supports both global and path-specific suppressions.

**Suppress a CVE in a specific file only** (e.g., a pinned dependency you can't upgrade yet):

```yaml
vulnerabilities:
  - id: CVE-2025-32434
    paths:
      - helm/jupyter/embedding-notebook/requirements.txt
    statement: "torch pinned at 2.0.1; upgrade to 2.6.0 pending validation"
```

**Suppress a CVE globally** (e.g., a base-image CVE with no available fix):

```yaml
vulnerabilities:
  - id: CVE-2025-12345
    statement: "no fix available in python:3.11-slim as of 2026-02"
```

The ignore file is referenced via `trivy.yaml` (Trivy config) because the trivy-action's `trivyignores` input [strips file extensions](https://github.com/aquasecurity/trivy-action/issues/284), breaking YAML parsing. Using `trivy-config` preserves the `.yaml` extension so Trivy correctly interprets the YAML format.

Both the Trivy repo scan (`security.yaml`) and image scan (`.github/actions/trivy-scan-image/`) use the same `trivy.yaml` config and therefore the same ignore file. Note that path-specific entries (`paths:`) use repo-relative paths and won't match inside container images — use global entries (without `paths`) for CVEs that should be suppressed in both scans.

### Changing Trivy severity thresholds

In the composite action (`.github/actions/trivy-scan-image/action.yaml`), the default severity is `CRITICAL,HIGH`. To scan only for CRITICAL:

```yaml
- uses: ./.github/actions/trivy-scan-image
  with:
    image-name: my-image
    severity: 'CRITICAL'
```

For the repo-level scan in `security.yaml`, edit the `severity` field directly in the workflow.

### Adding or removing Semgrep rule packs

Edit the `semgrep scan` command in `.github/workflows/security.yaml`:

```bash
semgrep scan --config p/default --config p/secrets --config p/docker --config p/kubernetes --config p/owasp-top-ten --sarif --output semgrep.sarif
```

Add `--config p/<pack>` for each new pack. After adding a pack, review findings in a test branch before merging to `main` to assess noise.

### Excluding paths from Semgrep

Edit `.semgrepignore` (gitignore syntax):

```
tests/
docs/
*.md
```

### Making dependency review block on HIGH severity (not just CRITICAL)

In `.github/workflows/dependency-review.yaml`:

```yaml
- uses: actions/dependency-review-action@v4
  with:
    fail-on-severity: high  # was 'critical'
```

### Adding a new container image to scanning

1. Add an entry to the `build-and-upload` matrix in `.github/workflows/ci.yaml`:

```yaml
strategy:
  matrix:
    include:
      # ... existing entries ...
      - image-name: new-image
        subproject: path/to/new-image
```

2. Add the image name to the `scan-images` matrix:

```yaml
scan-images:
  strategy:
    matrix:
      image-name:
        # ... existing entries ...
        - new-image
```

### Upgrading CodeQL query pack

In `.github/workflows/codeql.yml`, the `queries` field controls the query pack. Options:

- `security-extended` (current) — default + ~135 additional security queries
- `security-and-quality` — all security queries + code quality rules (significantly noisier)

## Scheduled scans

- **CodeQL**: Tuesdays at 01:36 UTC (configured in `codeql.yml`)
- **Trivy repo scan + Semgrep**: Mondays at 06:00 UTC (configured in `security.yaml`)

Scheduled scans catch newly disclosed CVEs and rule updates between code changes.
