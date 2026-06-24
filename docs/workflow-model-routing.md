# Workflow Model Routing

Khala routes workflow child sessions through named model profiles instead of
scattering model choices through prompts or command flags.

## Scopes

Pi has two independent model-configuration scopes:

**Pi session model** — flags that affect the current interactive Pi session:

```bash
pi --model provider/model --thinking high
```

**Khala workflow model routing** — flags/config that affect spawned workflow
sessions (`/workon`, `/plan`, `/triage`, etc.):

```bash
pi --khala-workflow-profile development --khala-workflow-task workon
```

These flags are read at session start and never change the current Pi session
model. You can use both scopes simultaneously without conflict.

## Flags

| Flag                              | Description                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `--khala-workflow-profile <name>` | Override profile for spawned workflow sessions (e.g. `development`, `planning`)         |
| `--khala-workflow-task <task>`    | Resolve a workflow route by task name (`workon` -> `development`, `plan` -> `planning`) |

## Durable Config

Instead of passing flags each time, create one of these files:

- Project install: `.pi/khala/workflow-model.yaml`
- Global install: `~/.pi/agent/khala/workflow-model.yaml`
- Custom global Pi config: `$PI_CODING_AGENT_DIR/khala/workflow-model.yaml`

Project config is used only after Pi trusts the project. If both project and
global config exist, the trusted project config wins.

Example:

```yaml
profiles:
  planning: "github-copilot/gpt-5.5:xhigh"
  development: "github-copilot/gpt-5.4-mini:medium"
  peer-review: "github-copilot/claude-opus-4.7:high"

routes:
  plan: "planning"
  debug: "planning"
  triage: "planning"
  workon: "development"
  review: "development"
  peer-review: "peer-review"
```

Profiles use `"provider/model:thinking"` format. Routes map workflow tasks to
profile names. Builtin defaults remain as fallback for any key not in the file.

## Precedence

```text
explicit workflow override > --khala-workflow-* flag >
  route config > profile config > builtin default
```

## Builtin Defaults

When no flags or config are provided:

| Task                         | Resolved profile | Model                                                                                  | Thinking |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------- | -------- |
| `/workon`                    | development      | Pi-discovered `gpt-5.4-mini` provider, preferring `github-copilot` then `openai-codex` | `medium` |
| `/plan`, `/triage`, `/debug` | planning         | `github-copilot/gpt-5.5`                                                               | `xhigh`  |
| Reviewer Two (`/plan`)       | peer-review      | `github-copilot/claude-opus-4.7`                                                       | `high`   |
| `/review`, `/audit`          | development      | Pi-discovered `gpt-5.4-mini` provider, preferring `github-copilot` then `openai-codex` | `medium` |

| Profile       | Default                                                                                | Thinking | Used by                        |
| ------------- | -------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| `planning`    | `github-copilot/gpt-5.5`                                                               | `xhigh`  | `/plan`, `/triage`, `/debug`   |
| `development` | Pi-discovered `gpt-5.4-mini` provider, preferring `github-copilot` then `openai-codex` | `medium` | `/workon`, `/review`, `/audit` |
| `peer-review` | `github-copilot/claude-opus-4.7`                                                       | `high`   | Reviewer Two in `/plan`        |

## Health

Run `/khala-health` to inspect resolution. Health output includes:

- **Session** section: enabled status, memory tool limit, compliance modes.
- **Model profiles** section: per-profile `OK`/`ERROR` status with resolved
  model, thinking level, used-by routes, problems, and fix steps.

If the development profile is unresolved, `/workon` refuses to handoff and
points you to `/khala-health` instead of silently falling back to planning.
