# CI Security Scanning

Scout's CI pipeline includes several layers of automated security scanning. This document describes each tool, what it does, how findings surface, and how to tune the configuration when scanners are too noisy or too quiet.

## Overview

| Tool | What it scans | Workflow file | Blocks PRs? | Findings visible in |
|---|---|---|---|---|
| **CodeQL** (`security-extended`) | Source code (JS/TS, Python, Java, Actions) | `codeql.yml` | Yes | Security tab > Code scanning |
| **Trivy image scan** | Container images built in CI | `ci.yaml` (scan jobs) | Yes (fixable CRITICAL/HIGH only) | Security tab > Code scanning |
| **Trivy repo scan** (vuln) | Dependency lockfiles in the repo | `security.yaml` | Yes (CRITICAL only) | Workflow logs |
| **Trivy repo scan** (misconfig) | Dockerfiles, Helm, Terraform, K8s YAML | `security.yaml` | No (informational) | Security tab > Code scanning |
| **Semgrep** | Ansible, YAML, Dockerfiles, secrets | `security.yaml` | Yes (error-level) | Security tab > Code scanning |
| **Dependency review** | New dependencies introduced in a PR | `dependency-review.yaml` | Yes (critical) | PR comment |
| **Dependabot** | Outdated dependencies and base images | `dependabot.yml` | N/A (opens PRs) | Pull requests |

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
├── dependabot.yml               # Automated dependency update PRs
.trivyignore                     # Suppressed CVEs for Trivy
.semgrepignore                   # Excluded paths for Semgrep
```

## How each scanner works

### CodeQL (`security-extended`)

CodeQL runs GitHub's static analysis on push to `main`, PRs to `main`, and weekly. The `security-extended` query pack adds ~135 security queries covering 35 additional CWEs beyond the default set, with minimal false positives. It covers JavaScript/TypeScript, Python, Java/Kotlin, and GitHub Actions.

**Configuration**: `.github/workflows/codeql.yml`, line with `queries: security-extended`.

### Trivy image scanning

A separate `scan-images` matrix job in `ci.yaml` runs in parallel with `deploy-and-test`, both triggered after `build-and-upload` completes. Each matrix entry downloads the image tarball artifact and scans it. The composite action (`.github/actions/trivy-scan-image/action.yaml`) does a single Trivy invocation:

1. **Single JSON scan** — Trivy scans once, outputting JSON. The Trivy DB is cached across runs via `actions/cache` to avoid re-downloading each time.
2. **SARIF conversion** — `trivy convert` produces SARIF from the JSON, which is uploaded to the GitHub Security tab for visibility.
3. **Gate check** — a shell step parses the JSON for fixable vulnerabilities and fails the job if any exist at CRITICAL or HIGH severity.

The `publish` and `publish-demo` jobs require `scan-images` in their `needs:` array, so a failed scan blocks publishing. Skipped scans (via `!cancelled()`) don't block it.

**Images scanned**: `hl7log-extractor`, `hl7-transformer`, `pyspark-notebook`, `embedding-notebook`, `launchpad`, `superset`, `keycloak`.

### Trivy repo scanning

The `security.yaml` workflow runs Trivy in filesystem mode against the entire repository:

- **Vulnerability scan** (`scanners: vuln`): Checks dependency lockfiles for known CVEs. Blocks PRs on CRITICAL severity findings.
- **Misconfiguration scan** (`scanners: misconfig`): Checks Dockerfiles, Helm charts, Terraform, and Kubernetes manifests for misconfigurations. Informational only (does not block PRs) — results appear in the Security tab.

### Semgrep

Runs in the `security.yaml` workflow inside the official `semgrep/semgrep` container. Current rule packs:

- `p/default` — general security rules
- `p/secrets` — hardcoded credentials, API keys
- `p/docker` — Dockerfile best practices

Fails the job on error-level findings. Results are uploaded as SARIF to the Security tab.

### Dependency review

The `dependency-review.yaml` workflow uses GitHub's first-party `actions/dependency-review-action`. On every PR, it diffs the dependency graph between the base and head commits and blocks the PR if any new dependency introduces a known critical vulnerability. It also posts a summary comment on the PR.

### Dependabot

Configured in `.github/dependabot.yml`. Automatically opens PRs for:

- **GitHub Actions** versions (weekly)
- **Docker base images** in all Dockerfiles (weekly)
- **npm** dependencies for launchpad and orchestrator (weekly)
- **Gradle** dependencies for hl7log-extractor (weekly)
- **pip** dependencies for hl7-transformer (weekly)

## Tuning and common modifications

### Suppressing a Trivy CVE

When a base-image CVE has no available fix, add it to `.trivyignore` in the repository root:

```
# No fix available in python:3.11-slim as of 2026-02
CVE-2025-12345
```

The SARIF report will still show the CVE in the Security tab for visibility, but the gate step won't fail on it. The `.trivyignore` file affects both the SARIF and gate passes.

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
semgrep scan --config p/default --config p/secrets --config p/docker --sarif --output semgrep.sarif --error
```

Useful additional packs to consider:
- `p/ansible` — Ansible-specific rules (may be noisy at first)
- `p/kubernetes` — Kubernetes manifest rules
- `p/owasp-top-ten` — OWASP Top 10 coverage

Add `--config p/<pack>` for each. After adding a pack, review findings in a test branch before merging to `main` to assess noise.

### Excluding paths from Semgrep

Edit `.semgrepignore` (gitignore syntax):

```
tests/
docs/
*.md
```

### Making Trivy IaC misconfig scan block PRs

In `.github/workflows/security.yaml`, change the misconfig scan's `exit-code` from `'0'` to `'1'`:

```yaml
- name: Trivy IaC misconfig scan (SARIF — informational)
  uses: aquasecurity/trivy-action@master
  with:
    exit-code: '1'  # was '0'
```

Do this only after triaging existing findings to avoid blocking all PRs immediately.

### Making dependency review block on HIGH severity (not just CRITICAL)

In `.github/workflows/dependency-review.yaml`:

```yaml
- uses: actions/dependency-review-action@v4
  with:
    fail-on-severity: high  # was 'critical'
```

### Adding a new container image to scanning

Add an entry to the `build-and-upload` matrix in `.github/workflows/ci.yaml`. The Trivy scan step runs automatically for any image that gets built:

```yaml
strategy:
  matrix:
    include:
      # ... existing entries ...
      - image-name: new-image
        subproject: path/to/new-image
```

No other changes needed — the scan step and publish gating are already wired up via the matrix.

### Adding a new Dependabot ecosystem

Add an entry to `.github/dependabot.yml`:

```yaml
- package-ecosystem: "<ecosystem>"
  directory: "/<path>"
  schedule:
    interval: "weekly"
```

See [Dependabot docs](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file) for supported ecosystems and options.

### Upgrading CodeQL query pack

In `.github/workflows/codeql.yml`, the `queries` field controls the query pack. Options:

- `security-extended` (current) — default + ~135 additional security queries
- `security-and-quality` — all security queries + code quality rules (significantly noisier)

### Viewing all findings

All SARIF-based scanners (CodeQL, Trivy, Semgrep) report to the GitHub **Security tab > Code scanning alerts**. Each scanner uploads with a distinct `category` so findings are filterable by tool.

## Scheduled scans

- **CodeQL**: Tuesdays at 01:36 UTC (configured in `codeql.yml`)
- **Trivy repo scan + Semgrep**: Mondays at 06:00 UTC (configured in `security.yaml`)

Scheduled scans catch newly disclosed CVEs and rule updates between code changes.
