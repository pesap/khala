# GitHub Actions optimization

## Workflow triggers & concurrency

**Concurrency control (prevent duplicate runs):**

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

**Path filters (only run when relevant files change):**

```yaml
on:
  push:
    paths:
      - "src/**"
      - "tests/**"
      - ".github/workflows/ci.yml"
```

## Dependency caching

**Python (pip):**

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: "3.12"
    cache: "pip"
```

**Node.js:**

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: "20"
    cache: "npm"
```

**Rust (cargo):**

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry
      ~/.cargo/git
      target/
    key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}
```

**Docker layer caching:**

```yaml
- uses: docker/build-push-action@v5
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

## Cache key strategies

| Strategy          | Example                                      | Use case          |
| ----------------- | -------------------------------------------- | ----------------- |
| Content-addressed | `deps-${{ hashFiles('package-lock.json') }}` | Dependency caches |
| Branch-based      | `build-${{ github.ref }}-${{ github.sha }}`  | Build outputs     |
| Rolling           | `data-${{ steps.date.outputs.week }}`        | Periodic refresh  |

**Cache limits:** 10GB per repo, 7 days unused retention.

## Matrix strategy

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
    python: ["3.10", "3.11", "3.12"]
  fail-fast: false
```

## Runner sizing

| Runner                  | vCPU | RAM  | Use for                 |
| ----------------------- | ---- | ---- | ----------------------- |
| `ubuntu-latest`         | 2    | 7GB  | Lint, format, typecheck |
| `ubuntu-latest-4-cores` | 4    | 16GB | Build, test             |
| `ubuntu-latest-8-cores` | 8    | 32GB | Heavy compilation       |

## Job dependencies & parallelism

```yaml
# Bad: unnecessary sequential
test:
  needs: lint

# Good: parallel jobs
lint:
test:
  needs: []
```

## Artifacts

**Upload only what's needed:**

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: coverage
    path: coverage/
    retention-days: 7
```

**Cross-job data passing:**

- Small (<1KB): use `$GITHUB_OUTPUT` and job outputs
- Medium: artifacts with short retention
- Build outputs for test jobs: prefer `actions/cache`

## Anti-patterns to avoid

- Sequential jobs that could run in parallel
- Missing dependency caches → full install every run
- Uploading `node_modules` or `.git` in artifacts
- No `timeout-minutes` on jobs
- Non-deterministic cache keys
- Caching secrets or credentials

## Security

- Pin actions to SHA, not just version tags
- Use OIDC for cloud auth instead of long-lived secrets
- Enable dependency review for PRs

## Workflow optimization checklist

1. Add `concurrency` groups to cancel in-progress on new push
2. Use path filters to skip irrelevant workflows
3. Order jobs: cheapest checks first (lint → typecheck → test → build)
4. Add `timeout-minutes` to every job
5. Cache all dependencies and build outputs
6. Use matrix `fail-fast: false` when you need all results
7. Set explicit `retention-days` on artifacts
8. Extract duplicated steps into reusable workflows
