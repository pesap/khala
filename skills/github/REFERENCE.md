# GitHub Reference

## Use when

- User asks to interact with GitHub PRs, issues, or runs via CLI
- User asks to optimize GitHub Actions workflows
- User asks about CI caching, artifacts, matrix builds, or runner sizing
- User mentions `gh`, GitHub CLI, or `.github/workflows`
- User asks to debug or view CI/CD failures

## Avoid when

- GitLab operations (use `gitlab` skill instead)
- Raw GitHub REST/GraphQL beyond `gh api`
- GitHub App or OAuth app development

## Consolidation note

This skill is the canonical home for GitHub Actions optimization guidance.
Legacy skills `workflow-optimization`, `caching-strategy`, and
`artifact-management` now delegate here.

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo`
when not in a git directory, or use URLs directly.

## Workflow

1. Confirm repo/target scope and desired outcome (PR status, CI fix, workflow
   optimization).
2. Collect evidence with `gh` commands (`pr`, `run`, `api --json/--jq`).
3. Diagnose bottlenecks/failures and propose minimal high-impact changes.
4. Validate with rerun/check commands where possible.
5. Summarize decisions, commands, and remaining risks.

## Pull Requests

Check CI status on a PR:

```bash
gh pr checks 55 --repo owner/repo
```

### Reply to reviewer comments in-thread (preferred)

List review comments and IDs:

```bash
gh api repos/OWNER/REPO/pulls/55/comments \
  --jq '.[] | {id, in_reply_to_id, user: .user.login, body, path, line, html_url}'
```

Reply directly to a review comment thread:

```bash
gh api -X POST repos/OWNER/REPO/pulls/55/comments \
  -F in_reply_to=COMMENT_ID \
  -f body='Thanks — addressed in commit abc123 on <file/section>.'
```

Delete mistaken general/standalone replies:

```bash
# General PR comment
gh api -X DELETE repos/OWNER/REPO/issues/comments/ISSUE_COMMENT_ID

# PR review comment
gh api -X DELETE repos/OWNER/REPO/pulls/comments/REVIEW_COMMENT_ID
```

Use `gh pr comment` only when there is no thread to reply to.

List recent workflow runs:

```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:

```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other
subcommands.

Get PR with specific fields:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to
filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```

## Issues

### Create issue with labels

```bash
gh issue create --repo owner/repo \
  --title "feat: my feature" \
  --label "enhancement" \
  --label "priority:high" \
  --body "Description here"
```

### Native Sub-issues (Parent/Child)

GitHub has built-in parent/child relationships. Use GraphQL API.

**Query sub-issues:**

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    issue(number: 176) {
      subIssues(first: 10) {
        nodes { number title }
      }
    }
  }
}'
```

**Query parent:**

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    issue(number: 177) {
      parent { number title }
    }
  }
}'
```

**Get node IDs (required for mutations):**

```bash
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    parent: issue(number: 176) { id }
    child: issue(number: 177) { id }
  }
}'
```

**Add sub-issue:**

```bash
gh api graphql -f query='
mutation {
  addSubIssue(input: {
    issueId: "PARENT_NODE_ID",
    subIssueId: "CHILD_NODE_ID"
  }) {
    issue { number }
    subIssue { number }
  }
}'
```

**Remove sub-issue:**

```bash
gh api graphql -f query='
mutation {
  removeSubIssue(input: {
    issueId: "PARENT_NODE_ID",
    subIssueId: "CHILD_NODE_ID"
  }) {
    issue { number }
    subIssue { number }
  }
}'
```

### Dependencies between sibling issues

No native "blocked by" in GitHub. Document in issue body:

```markdown
Blocked by: #178
```

## GitHub Actions CI/CD Optimization

### Workflow triggers & concurrency

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

### Dependency caching

**Python (pip):**

```yaml
- uses: actions/setup-python@v5
  with:
    python-version: "3.12"
    cache: "pip" # Built-in
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

### Cache key strategies

| Strategy          | Example                                      | Use case          |
| ----------------- | -------------------------------------------- | ----------------- |
| Content-addressed | `deps-${{ hashFiles('package-lock.json') }}` | Dependency caches |
| Branch-based      | `build-${{ github.ref }}-${{ github.sha }}`  | Build outputs     |
| Rolling           | `data-${{ steps.date.outputs.week }}`        | Periodic refresh  |

**Cache limits:** 10GB per repo, 7 days unused retention.

### Matrix strategy

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest]
    python: ["3.10", "3.11", "3.12"]
  fail-fast: false # Run all even if one fails
```

### Runner sizing

| Runner                  | vCPU | RAM  | Use for                 |
| ----------------------- | ---- | ---- | ----------------------- |
| `ubuntu-latest`         | 2    | 7GB  | Lint, format, typecheck |
| `ubuntu-latest-4-cores` | 4    | 16GB | Build, test             |
| `ubuntu-latest-8-cores` | 8    | 32GB | Heavy compilation       |

### Job dependencies & parallelism

```yaml
# Bad: unnecessary sequential
test:
  needs: lint  # If independent, remove this

# Good: parallel jobs
lint:
test:
  needs: []  # Or omit needs entirely
```

### Artifacts

**Upload only what's needed:**

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: coverage
    path: coverage/
    retention-days: 7 # Default is 90
```

**Cross-job data passing:**

- Small (<1KB): use `$GITHUB_OUTPUT` and job outputs
- Medium: artifacts with short retention
- Build outputs for test jobs: prefer `actions/cache` (faster)

### Anti-patterns to avoid

- Sequential jobs that could run in parallel
- Missing dependency caches → full install every run
- Uploading `node_modules` or `.git` in artifacts
- No `timeout-minutes` on jobs
- Non-deterministic cache keys (timestamp without content hash)
- Caching secrets or credentials

### Security

- Pin actions to SHA, not just version tags
- Use OIDC for cloud auth instead of long-lived secrets
- Enable dependency review for PRs

### Workflow optimization checklist

1. Add `concurrency` groups to cancel in-progress on new push
2. Use path filters to skip irrelevant workflows
3. Order jobs: cheapest checks first (lint → typecheck → test → build)
4. Add `timeout-minutes` to every job
5. Cache all dependencies and build outputs
6. Use matrix `fail-fast: false` when you need all results
7. Set explicit `retention-days` on artifacts
8. Extract duplicated steps into reusable workflows

## Output

- Command evidence (key `gh` output snippets)
- Findings and optimization recommendations
- Proposed/implemented workflow changes
- Validation status and follow-up actions
