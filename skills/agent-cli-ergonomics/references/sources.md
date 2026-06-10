# Sources for agent CLI ergonomics

These sources informed `agent-cli-ergonomics`. Use them when you need provenance, citations, or deeper guidance.

## Primary sources used

### CLI Guidelines

URL: https://clig.dev/

Relevant guidance:
- Return zero exit code on success and non-zero on failure.
- Send primary output and machine-readable data to stdout.
- Send logs, errors, progress, prompts, and diagnostics to stderr.
- Show `-h`/`--help` for main commands and subcommands.
- Display JSON when `--json` is passed.
- Disable color when output is not a TTY, when `NO_COLOR` is set, or when `TERM=dumb`.
- Do not require prompts; provide flags or arguments for every input.
- Use `--no-input` to disable prompts and fail with guidance if input is missing.
- Use `-n`/`--dry-run` to describe changes without performing them.
- Treat command flags, arguments, config, environment variables, and stable output as public interfaces.

How it changes the skill:
- Strengthens stdout/stderr, color, help, no-input, dry-run, and compatibility checks.

### The CLI Spec

URL: https://clispec.dev/

Relevant guidance:
- Design CLI tools for humans, scripts, and AI agents simultaneously.
- Support structured output and explicit `--output` or `-o` format selection.
- Provide schema introspection so consumers can discover commands, arguments, output fields, error types, and mutation markers.
- Separate stdout data from stderr messages, progress, and diagnostics.
- Never block on input without a TTY.
- Make repeat operations idempotent where possible; incompatible repeats should return a conflict error kind.
- Support bounded output with `--limit`, pagination, and `--fields`.

How it changes the skill:
- Adds introspection, mutation markers, idempotency, and context-bounding as first-class audit criteria.

### Agentic CLI Design article

URL: https://dev.to/tumf/agentic-cli-design-7-principles-for-designing-cli-as-a-protocol-for-ai-agents-2c10

Relevant guidance:
- Treat CLI as a protocol/API invoked by agents.
- Optimize for machines to read, decide, re-execute, and recover.
- Seven principles: machine-readable, non-interactive by default, idempotent and replayable, safe-by-default, observable and debuggable, context-efficient, and introspectable.
- Use structured success and failure envelopes with `ok`, `type`, `schemaVersion`, data, and error fields.
- Use Device Authorization Grant for headless OAuth when possible.
- Provide `commands --json`, `schema --command ... --output json-schema`, and `--help --json`.

How it changes the skill:
- Adds the 7-principle second pass, context efficiency, recovery, and auth-specific guidance.

### tumf/skills `agentic-cli-design`

URL: https://github.com/tumf/skills/tree/main/agentic-cli-design

Relevant guidance:
- Provides skill-ready wording, scorecards, templates, and anti-patterns for agentic CLI design.
- Recommends task recipes, guardrails, JSON success/failure examples, recovery procedures, recommended defaults, and an optional `install-skills` flow for a CLI's own bundled skill.
- Scorecard covers machine-readable output, non-interactive behavior, idempotency, safe-by-default destructive operations, observability, context efficiency, and introspection.

How it changes the skill:
- Adds richer output-quality eval criteria and more concrete implementation patterns.

### Fuchsia CLI guidelines

URL: https://fuchsia.dev/fuchsia-src/development/api/cli

Relevant guidance:
- Supports explicit interactive and non-interactive behavior.
- Emphasizes predictable command behavior for automation.

How it changes the skill:
- Reinforces that non-interactive behavior should be explicit and testable, not an afterthought.

### PatternFly CLI handbook

URL: https://www.patternfly.org/developer-resources/cli-handbook/writing-guidelines/

Relevant guidance:
- Encourages clear output options, useful help, and dry-run/simulation patterns.

How it changes the skill:
- Reinforces human-facing clarity while preserving machine contracts.

## Reference preview that started this skill

URL: https://jeffreys-skills.md/skills/agent-ergonomics-and-intuitiveness-maximization-for-cli-tools

Visible public-preview guidance:
- Score and aggressively improve CLI ergonomics for AI agents.
- Focus on agent-friendly CLI UX, robot/json modes, help/errors, and in-tree fixes.
- Surface types: verb subcommand, doc help text, meta capabilities, and msg error message.
- 11 abbreviated dimensions: `intu`, `ergo`, `ease`, `parse`, `errp`, `intnt`, `safe`, `det`, `doc`, `comp`, `regr`.
- Buckets: `fail<400`, `mid<700`, `pass>=700`.

Important limitation:
- The full downloadable reference skill was not available from the public preview. This local skill is source-backed and directionally similar, not a copy or verified equivalent.

## Suggested citations in reviews

Use these when writing a CLI audit with references:

- CLI Guidelines: https://clig.dev/
- CLI Spec: https://clispec.dev/
- Agentic CLI Design: https://dev.to/tumf/agentic-cli-design-7-principles-for-designing-cli-as-a-protocol-for-ai-agents-2c10
- tumf/skills agentic-cli-design: https://github.com/tumf/skills/tree/main/agentic-cli-design
- Fuchsia CLI guidelines: https://fuchsia.dev/fuchsia-src/development/api/cli
- PatternFly CLI handbook: https://www.patternfly.org/developer-resources/cli-handbook/writing-guidelines/
