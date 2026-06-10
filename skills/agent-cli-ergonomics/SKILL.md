---
name: agent-cli-ergonomics
description: Audit and improve command-line tools for AI-agent ergonomics, intuitiveness, and automation reliability. Use when users ask whether a CLI is agent-friendly, robot-friendly, easy for agents to discover, parse, recover from errors, avoid hangs, stay within context limits, or operate safely, or when adding or reviewing --json, --output, --robot, capability/schema discovery, structured errors, help text, deterministic output, dry-run, pagination, or non-interactive modes.
license: MIT
---

## Use when
- Auditing a CLI for AI-agent usability, automation safety, or machine-readable operation.
- Designing or improving `--json`, `--output`, `--robot`, `--porcelain`, `--dry-run`, `--yes`, `--no-input`, `capabilities`, `schema`, `commands`, `doctor`, or `version` surfaces.
- Reviewing help text, error messages, command naming, output stability, exit codes, pagination, context size, or recovery suggestions for agent workflows.
- Making tools easier for coding agents to discover, call, parse, retry, and validate without brittle screen scraping.
- Comparing human CLI UX against agent needs where deterministic automation matters.

## Avoid when
- The task is general CLI UX with no agent or automation angle; use `cli-ux` first.
- The task is shell-script implementation internals; use `bash-script` instead.
- Product correctness, security, or performance dominates and CLI surface behavior is not changing.

## Core principle
Treat a CLI as both a human interface and an agent-facing protocol. A CLI is agent-friendly when an agent can discover supported actions, run them non-interactively, parse stable results, bound output size, recover from expected failures, and avoid unsafe side effects without reading source code or scraping human prose.

## Workflow
1. **Collect deterministic evidence first**
   - Capture bounded examples: `tool --help`, representative `tool <verb> --help`, a read-only command, a write/destructive command if present, one expected error, one machine-output path, and one metadata path.
   - Record streams and exit codes separately when possible: stdout, stderr, and status.
   - Do not score from vibes when output examples are available.
2. **Inventory agent surfaces**
   - `verb`: command and subcommand behavior, including mutating and read-only paths.
   - `doc`: help, examples, man pages, README snippets, and output stability notes.
   - `meta`: `schema`, `commands --json`, `capabilities --json`, `version --json`, `doctor --json`, or equivalents.
   - `msg`: structured errors, warnings, progress, logs, status, and recovery text.
3. **Score with the agent rubric**
   - Use `references/agent-cli-rubric.md` for the 11-dimension surface score and the 7-principle source-backed checklist.
   - Mark each surface `fail`, `mid`, `pass`, or `unknown`; unknowns are findings, not assumptions.
   - Prefer the stricter score when human UX and machine contract disagree.
4. **Prioritize fixes by agent failure mode**
   - First: parseability, stream separation, structured errors, and stable exit status.
   - Second: non-interactive operation, dry-run/confirm flows, idempotency, and bounded output.
   - Third: schema/capability discovery, help polish, examples, and regression tests.
5. **Preserve human UX while adding machine contracts**
   - Keep human output readable, concise, and discoverable.
   - Put stable data in explicit machine modes or documented auto-detected modes.
   - Never require agents to scrape colorful tables, progress spinners, localized prose, or terminal-width-dependent output.
6. **Validate with golden agent tasks**
   - Can an agent discover the command set and mutation markers?
   - Can an agent run a read-only query and parse it with `jq` or equivalent?
   - Can an agent detect missing file, bad flag, auth, rate limit, timeout, and conflict from structured data?
   - Can an agent preview destructive work without mutating state?
   - Can an agent request bounded output using `--limit`, `--cursor`, `--fields`, or `--output ndjson`?

## Required audit checklist
- Discovery: every command has fast `--help`; command names and aliases are predictable.
- Introspection: the CLI exposes command, flag, output, error, and mutating/read-only metadata in machine-readable form where practical.
- Intent: verbs map to one action; destructive verbs require preview or explicit confirmation.
- Machine contract: stable structured output exists for data-bearing commands.
- Parseability: data is not mixed with progress, warnings, or decoration on stdout.
- Errors: failures include stable code/kind, category, human message, structured details, retryability when useful, remediation, and exit code.
- Safety: dry-run or plan mode exists for destructive, broad, or expensive mutations.
- Idempotency: safe retries are supported through no-op repeat behavior, dedupe keys, or explicit conflict policies.
- Determinism: timestamps, ordering, locale, color, pager, and TTY differences are controlled or documented.
- Context efficiency: list/detail commands support pagination, field selection, summaries by default, and NDJSON for streams.
- Non-interactive: prompts have flag/config/stdin equivalents; CI and non-TTY mode cannot hang.
- Documentation: examples include expected output, machine-mode examples, exit codes, and stability policy.
- Compatibility: output schema and flags are versioned or explicitly unstable.
- Regression tests: help, errors, structured output, non-TTY mode, pagination, and safety paths have golden tests.

## Progressive disclosure
- Read `references/agent-cli-rubric.md` for the scoring table, source-backed principles, and improvement patterns.
- Read `references/sources.md` when you need citations, provenance, or deeper source links.
- Use `evals/trigger-prompts.json` when refining trigger behavior.
- Use `evals/evals.json` when checking output quality for non-trivial audits.

## Output
- Agent ergonomics verdict: fail, mid, or pass, with score.
- Surface inventory with scores and unknowns.
- Top 3 fixes ranked by agent impact and implementation risk.
- Machine contract recommendations: output format, schema/versioning, streams, exit codes, and introspection.
- Safety and non-interactive recommendations.
- Context-efficiency recommendations: pagination, field selection, summaries, and streaming.
- Validation plan with concrete commands or golden tests.
