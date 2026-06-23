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

| Flag | Description |
|------|-------------|
| `--khala-workflow-profile <name>` | Override profile for spawned workflow sessions (e.g. `development`, `planning`) |
| `--khala-workflow-task <task>` | Resolve a workflow route by task name (`workon` -> `development`, `plan` -> `planning`) |

## Durable Config

Instead of passing flags each time, create `~/.pi/khala/workflow-model.yaml`:

```yaml
profiles:
  planning: "github-copilot/gpt-5.5:xhigh"
  development: "github-copilot/gpt-5.4-mini:medium"
  review: "github-copilot/gpt-5.5:high"

routes:
  plan: "planning"
  debug: "planning"
  triage: "planning"
  workon: "development"
  review: "review"
```

Profiles use `"provider/model:thinking"` format. Routes map workflow tasks to
profile names. Builtin defaults remain as fallback for any key not in the file.

## Precedence

```
explicit workflow override > --khala-workflow-* flag >
  route config > profile config > builtin default
```

## Builtin Defaults

When no flags or config are provided:

| Task | Resolved profile | Model | Thinking |
|------|-----------------|-------|----------|
| `/workon` | development | `github-copilot/gpt-5.4-mini` (Pi-discovered) | `medium` |
| `/plan`, `/triage`, `/debug` | planning | `github-copilot/gpt-5.5` | `xhigh` |
| `/review`, `/audit` | development | `github-copilot/gpt-5.4-mini` (Pi-discovered) | `medium` |

| Profile | Default | Thinking | Used by |
|---------|---------|----------|---------|
| `planning` | `github-copilot/gpt-5.5` | `xhigh` | `/plan`, `/triage`, `/debug` |
| `development` | Pi-discovered `github-copilot/gpt-5.4-mini` | `medium` | `/workon`, `/review`, `/audit` |

## Health

Run `/khala-health` to inspect resolution. Health output includes:

- **Session** section: enabled status, memory tool limit, compliance modes.
- **Pi session model** section: current interactive Pi model and thinking.
- **Khala workflow model routing** section: active `--khala-workflow-*` flags.
- **Model profiles** section: per-profile `OK`/`WARNING`/`ERROR` status with
  resolved model, thinking level, used-by routes, problems, and fix steps.

If the development profile is unresolved, `/workon` refuses to handoff and
points you to `/khala-health` instead of silently falling back to planning.
