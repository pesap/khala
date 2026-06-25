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
  planning: "NLR/HALO Nemotron 3 Super:off"
  development: "NLR/HALO Devstral 123B:off"
  peer-review: "NLR/HALO GPT OSS 120b:off"
  triage: "NLR/HALO Llama 4 Scout:off"
  knowledge: "NLR/HALO Gemma 4:off"
  lightweight: "NLR/HALO Nemotron 3 Nano:off"

routes:
  plan: "planning"
  debug: "planning"
  triage: "triage"
  workon: "development"
  review: "peer-review"
  git-review: "knowledge"
  simplify: "development"
  ship: "development"
  inbox: "lightweight"
  audit: "planning"
  address-open-issues: "planning"
  learn-skill: "knowledge"
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

|Task|Resolved profile|Model|Thinking|
|---|---|---|---|
|`/workon`, `/simplify`, `/ship`|development|`NLR/HALO Devstral 123B`|`off`|
|`/plan`, `/debug`, `/audit`, `/address-open-issues`|planning|`NLR/HALO Nemotron 3 Super`|`off`|
|Reviewer Two, `/review`|peer-review|`NLR/HALO GPT OSS 120b`|`off`|
|`/triage`|triage|`NLR/HALO Llama 4 Scout`|`off`|
|`/git-review`, `/learn-skill`|knowledge|`NLR/HALO Gemma 4`|`off`|
|`/inbox`|lightweight|`NLR/HALO Nemotron 3 Nano`|`off`|

All builtin NLR HALO profile entries use `thinking=off` because the current
NLR discovery rows for these models report no thinking support.

|Profile|Default|Thinking|Used by|
|---|---|---|---|
|`planning`|`NLR/HALO Nemotron 3 Super`|`off`|`/plan`, `/debug`, `/audit`, `/address-open-issues`|
|`development`|`NLR/HALO Devstral 123B`|`off`|`/workon`, `/simplify`, `/ship`|
|`peer-review`|`NLR/HALO GPT OSS 120b`|`off`|Reviewer Two, `/review`|
|`triage`|`NLR/HALO Llama 4 Scout`|`off`|`/triage`|
|`knowledge`|`NLR/HALO Gemma 4`|`off`|`/git-review`, `/learn-skill`|
|`lightweight`|`NLR/HALO Nemotron 3 Nano`|`off`|`/inbox`|

## Health

Run `/khala-health` to inspect resolution. Health output includes:

- **Session** section: enabled status, memory tool limit, compliance modes.
- **Model profiles** section: per-profile `OK`/`ERROR` status with resolved
  model, thinking level, used-by routes, problems, and fix steps.

If a resolved development profile is invalid or unresolved, `/workon` refuses
to handoff and points you to `/khala-health` instead of silently falling back to
planning.
