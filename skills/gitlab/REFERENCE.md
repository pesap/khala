# GitLab Reference

## Use when

- User asks to create, view, list, or manage GitLab merge requests
- User asks to create, view, list, or manage GitLab issues
- User asks to view, retry, or manage CI/CD pipelines and jobs
- User asks to create releases or changelogs
- User asks to authenticate with GitLab (`glab auth login`)
- User mentions `glab`, GitLab CLI, or asks "how do I do X in GitLab from
  terminal"
- User asks to create, edit, or debug `.gitlab-ci.yml` pipeline configuration
- User asks about CI/CD variables, stages, jobs, rules, or artifacts

## Avoid when

- Task requires raw GitLab REST/GraphQL API calls beyond `glab api`
- Deep Kubernetes agent configuration (use dedicated k8s skill)
- GitHub operations (use `gh` CLI skill instead)

## Workflow

1. Confirm target repo/group and objective (MR/issue/pipeline/release/CI
   config).
2. Gather current state with `glab` list/view/status commands.
3. Diagnose failures or process gaps and propose minimal corrective changes.
4. Validate with follow-up `glab` checks (or pipeline rerun when applicable).
5. Summarize actions, evidence, and residual risks.

## Quick reference

### Authentication

```bash
glab auth login                  # Interactive OAuth or PAT setup
glab auth status                 # Check auth status
```

For self-managed: set `GITLAB_HOST=https://gitlab.example.com` before login.

### Merge requests

```bash
glab mr list                     # List open MRs
glab mr view <id>                # View MR details
glab mr create                   # Create MR interactively
glab mr create -f -t "title"     # Create MR non-interactively
glab mr checkout <id>            # Checkout MR branch locally
glab mr merge <id>               # Merge MR
glab mr approve <id>             # Approve MR
glab mr diff <id>                # View MR diff
```

### Issues

```bash
glab issue list                  # List open issues
glab issue view <id>             # View issue details
glab issue create -t "title"     # Create issue
glab issue close <id>            # Close issue
```

### CI/CD

```bash
glab ci status                   # Current pipeline status
glab ci view                     # View pipeline in browser
glab ci list                     # List recent pipelines
glab ci retry                    # Retry failed jobs
glab job list                    # List jobs in pipeline
glab job trace <job-id>          # View job logs
```

### Releases

```bash
glab release create v1.0.0       # Create release
glab release list                # List releases
glab changelog generate          # Generate changelog
```

### Repo & config

```bash
glab repo clone <project>        # Clone repository
glab repo view                   # View repo in browser
glab config set editor vim       # Set default editor
```

## CI/CD pipeline configuration

Pipelines defined in `.gitlab-ci.yml` at repo root.

### Minimal example

```yaml
stages:
  - build
  - test
  - deploy

build-job:
  stage: build
  script:
    - echo "Building..."

test-job:
  stage: test
  script:
    - echo "Testing..."

deploy-job:
  stage: deploy
  script:
    - echo "Deploying from $CI_COMMIT_BRANCH"
  environment: production
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

### Key keywords

| Keyword                          | Purpose                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `stages`                         | Define execution order (jobs in same stage run parallel) |
| `script`                         | Commands to execute                                      |
| `rules`                          | Conditions for when job runs (`if`, `when`, `changes`)   |
| `needs`                          | Run jobs out of stage order (DAG)                        |
| `artifacts`                      | Pass files between jobs                                  |
| `cache`                          | Persist dependencies across pipelines                    |
| `variables`                      | Define CI/CD variables                                   |
| `image`                          | Docker image for job                                     |
| `services`                       | Additional containers (e.g., postgres, redis)            |
| `before_script` / `after_script` | Run before/after main script                             |
| `default`                        | Apply settings to all jobs                               |
| `include`                        | Import external YAML or components                       |
| `environment`                    | Link job to deployment environment                       |

### Common patterns

**Conditional deploy (only main branch):**

```yaml
deploy:
  script: ./deploy.sh
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

**Run on MR only:**

```yaml
test:
  script: pytest
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

**Pass artifacts between jobs:**

```yaml
build:
  script: make build
  artifacts:
    paths:
      - dist/
    expire_in: 1 hour

test:
  script: make test
  needs: [build] # Gets build artifacts automatically
```

**Cache dependencies:**

```yaml
test:
  cache:
    key: $CI_COMMIT_REF_SLUG
    paths:
      - node_modules/
  script:
    - npm ci
    - npm test
```

**File-based cache key (max 2 files):**

```yaml
.cache-deps:
  cache:
    - key:
        files:
          - package-lock.json # max 2 files allowed!
          - pixi.lock
        prefix: deps
      paths:
        - node_modules/
        - .pixi/
      policy: pull-push
```

> ⚠️ **Limit**: `cache:key:files` accepts **maximum 2 files**. Use `prefix` to
> add context.

**Matrix jobs (parallel variants):**

```yaml
test:
  parallel:
    matrix:
      - PYTHON: ["3.10", "3.11", "3.12"]
  image: python:$PYTHON
  script: pytest
```

### Predefined variables (commonly used)

| Variable              | Value                                                      |
| --------------------- | ---------------------------------------------------------- |
| `CI_COMMIT_BRANCH`    | Branch name                                                |
| `CI_COMMIT_SHA`       | Full commit SHA                                            |
| `CI_COMMIT_SHORT_SHA` | Short SHA (8 chars)                                        |
| `CI_PIPELINE_SOURCE`  | Trigger source (push, merge_request_event, schedule, etc.) |
| `CI_PROJECT_NAME`     | Project name                                               |
| `CI_JOB_TOKEN`        | Token for API calls within job                             |
| `GITLAB_USER_LOGIN`   | Username who triggered pipeline                            |

## Environment variables

| Variable       | Purpose                                |
| -------------- | -------------------------------------- |
| `GITLAB_HOST`  | Self-managed URL (default: gitlab.com) |
| `GITLAB_TOKEN` | Auth token (avoids prompts)            |
| `NO_PROMPT`    | Disable interactive prompts            |

## Safety notes

- `glab mr merge` is destructive; confirm target branch and approvals first
- `glab release create` publishes immediately; verify tag and assets
- For CI auto-login in pipelines: set `GLAB_ENABLE_CI_AUTOLOGIN=true`

## Docs

- Main: https://docs.gitlab.com/cli/
- Install: https://gitlab.com/gitlab-org/cli/#installation
- Auth: https://gitlab.com/gitlab-org/cli#authentication
- CI/CD: https://docs.gitlab.com/ci/
- YAML reference: https://docs.gitlab.com/ci/yaml/

## Output

- Command evidence (key `glab` output snippets)
- Findings and recommended actions
- Proposed/implemented pipeline or workflow changes
- Validation status and next steps
