# Agent CLI ergonomics rubric

Use this rubric to score how well a command-line tool supports coding agents and other automation clients. It combines the public preview dimensions from the referenced skill page with source-backed guidance from CLI Guidelines, CLI Spec, Fuchsia CLI guidelines, PatternFly CLI handbook, and the open `agentic-cli-design` skill.

## Evidence to collect

For each audited CLI, collect bounded examples before scoring:

1. Top-level help: `tool --help`.
2. One read-only command and its help.
3. One write or destructive command and its help, if present.
4. One successful machine-output example.
5. One expected error example.
6. One metadata endpoint, for example `schema`, `commands --json`, `capabilities --json`, `version --json`, or `doctor --json`.
7. stdout, stderr, and exit code for at least one success and one failure.

Do not mark a surface as passing without evidence. Use `unknown` when the evidence is unavailable.

## Surface scoring

Score each audited surface from 0 to 100 for each dimension, then average to a 0 to 1000 total.

Buckets:
- `fail`: below 400. Agents are likely to stall, scrape, mutate accidentally, or require human repair.
- `mid`: 400 to 699. Agents can use the tool with caveats, wrappers, or extra retries.
- `pass`: 700 and above. Agents can discover, call, parse, and recover reliably.

Common surfaces:
- `verb`: command and subcommand behavior, for example `tool list` or `tool delete`.
- `doc`: `--help`, examples, man pages, README snippets, and stability notes.
- `meta`: `schema`, `commands --json`, `capabilities --json`, `version --json`, `doctor --json`, or equivalent discovery endpoints.
- `msg`: error messages, warnings, progress, logs, status output, and recovery guidance.

## 11 dimensions

| Dimension | What good looks like | Failure smells |
|---|---|---|
| Intuitiveness | Names, verbs, nouns, and aliases are guessable from user intent. | Cute names, hidden modes, inconsistent verb meanings. |
| Ergonomics | Common tasks are one or two predictable commands with safe defaults. | Long flag chains for common tasks, required config before read-only use. |
| Ease | First successful read-only command is easy to discover and run. | No useful no-arg behavior, help lacks examples, setup errors appear late. |
| Parseability | Machine mode emits stable structured data and separates diagnostics. | Agents must scrape tables, colors, spinners, or mixed stdout/stderr data. |
| Error precision | Failures expose category, stable code/kind, subject, cause, retryability, and next action. | Generic `failed`, stack traces only, no remediation or stable code. |
| Intent clarity | Commands do one clear thing and expose mutating/read-only status. | Ambiguous verbs, broad defaults, hidden network or filesystem side effects. |
| Safety | Destructive operations require dry-run, explicit confirmation, and scoped targets. | Prompts are the only safeguard, `--force` is unclear, no rollback guidance. |
| Determinism | Output order, time, locale, color, pager, TTY behavior, and width are controlled or documented. | Non-deterministic ordering, timestamps in golden output, TTY-only behavior. |
| Documentation | Help and docs include examples, expected output, exit codes, and machine-mode contracts. | Human prose only, missing subcommand help, machine output undocumented. |
| Compatibility | Flags, output schemas, and exit codes are versioned or marked unstable. | Silent schema drift, breaking flag changes, localized machine fields. |
| Regression coverage | Golden tests cover help, structured output, errors, non-TTY mode, context bounds, and safety paths. | Only happy-path tests, no CLI contract tests, no non-TTY or CI tests. |

## 7 source-backed agent principles

Use this checklist for a second pass. It is especially useful when the 11-dimension surface score hides a critical failure.

| Principle | Pass condition | Typical evidence |
|---|---|---|
| Machine-readable | Data-bearing commands support stable JSON/YAML/text output and structured errors. | `--json`, `--output json`, stable envelope, `schemaVersion`, valid `jq` parse. |
| Non-interactive | Commands complete or fail clearly without a TTY; prompts have flag/stdin equivalents. | `--no-input`, `--yes`, `--non-interactive`, CI behavior, no hangs. |
| Idempotent and replayable | Retries are safe or conflicts are explicit. | no-op repeats, `--client-request-id`, `--dedupe-key`, `--if-exists`, conflict errors. |
| Safe-by-default | Destructive or broad mutations have preview and explicit approval. | `--dry-run`, `plan`, `--confirm <id>`, scoped targets, reversible defaults. |
| Observable and debuggable | Agents can understand state, failures, retries, and support context. | `status`, `doctor`, `--debug`, `--log-format json`, `--trace-id`, retryable errors. |
| Context-efficient | Output volume and fields are bounded and selectable. | `--limit`, `--cursor`, `--fields`, `--select`, `--include-*`, `--output ndjson`. |
| Introspectable | Agents can discover commands, flags, schemas, errors, and mutation markers at runtime. | `schema`, `commands --json`, `--help --json`, `capabilities --json`, JSON Schema. |

## Audit method

1. Choose representative surfaces:
   - One read-only command.
   - One write or destructive command if present.
   - Main help and subcommand help.
   - One expected error path.
   - One machine-output path.
   - One capability, schema, or metadata endpoint if present.
2. Capture bounded evidence:
   - Help excerpt.
   - Example command output.
   - stdout/stderr separation.
   - Exit code behavior.
   - Schema or field names for machine output.
   - Safety prompt, dry-run, or confirm behavior.
3. Score dimensions only from evidence.
4. Mark missing surfaces explicitly as `unknown` or `not present`.
5. Recommend the smallest changes that unblock reliable agent use.

## High-leverage improvement patterns

### Add a stable machine contract

Prefer an explicit machine mode over making human output parseable.

Good properties:
- Flag names: `--json`, `--output json`, `--output yaml`, or `--porcelain`.
- JSON object top level with `ok`, `data`, `warnings`, and `error` fields.
- Stable schema version, for example `schemaVersion: 1`.
- Diagnostics on stderr unless included in structured `warnings`.
- No color, spinner, wrapping, pager, or localization in machine mode.

### Add schema and capability discovery

Agents need to know what the installed tool supports.

Useful endpoints:
- `tool schema --output json`: commands, flags, output fields, error kinds, mutation markers.
- `tool commands --json`: command tree and examples.
- `tool capabilities --json`: output formats, dry-run support, non-interactive support, auth state checks.
- `tool version --json`: binary version, build metadata, schema version.
- `tool doctor --json`: environment readiness, auth, config, dependencies, and paths.

### Make errors actionable and parseable

Structured error fields:
- `code` or `kind`: stable identifier, for example `FILE_NOT_FOUND` or `not_found`.
- `category`: `usage`, `environment`, `auth`, `network`, `conflict`, `rate_limit`, or `internal`.
- `message`: human-readable summary.
- `subject`: path, flag, resource, or command involved.
- `details`: structured context.
- `remediation` or `suggestion`: concrete next action.
- `retryable`: boolean when useful.
- `retryAfterMs`: delay for rate limits or transient failures when known.
- `requestId` or `traceId`: support/debug correlation.

### Separate streams

- stdout: primary data only.
- stderr: progress, warnings, diagnostics, prompts, and human status.
- exit code: success or failure category.
- machine mode: no progress unless requested and structured.

### Make risky actions previewable

For mutations, support:
- `--dry-run` or `plan`.
- Machine-readable plan output.
- Explicit target scoping.
- Confirmation by specific ID for severe operations: `--confirm <id>`.
- `--yes` or `--no-input` for automation where appropriate.
- Idempotent behavior where practical.

### Bound output for agent context windows

For list and log commands, support:
- `--limit` with a safe default.
- `--cursor` or `--offset` pagination.
- `--fields` or `--select` projection.
- `--include-*` for heavy fields.
- `--output ndjson` for long streams.
- Summaries by default, details through `get` or explicit include flags.

## Example audit output

```text
Verdict: mid, 610/1000
Surfaces:
- verb `tool list --json`: pass, structured and stable, no schema version.
- doc `tool --help`: mid, examples present but no machine-mode mention.
- meta `tool schema --output json`: fail, endpoint missing.
- msg missing file error: fail, exits 1 with prose only and no remediation.

Top fixes:
1. Add structured error envelope for `--json` failures.
2. Add `tool schema --output json` with commands, output fields, errors, and mutation markers.
3. Add golden tests for help text, JSON list output, non-TTY behavior, and missing-file error.
```
