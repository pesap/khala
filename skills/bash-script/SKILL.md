---
name: bash-script
description: Write, review, or harden Bash scripts for reliable team, CI, and operator-facing CLI use. Use when users ask for shell scripts, Bash best practices, strict mode, argument handling, quoting, cleanup traps, idempotent setup/deploy scripts, ShellCheck-style fixes, clean-code shell structure, Bash pitfalls, safe filename handling, interactive terminal UX, or whether a task has outgrown Bash.
license: MIT
---

## Use when
- Creating or revising `.sh`/Bash automation for local dev, CI, deploys, setup, or glue tasks.
- Reviewing shell scripts for safety, portability, quoting, argument handling, logging, cleanup, readability, and idempotency.
- Spotting common Bash pitfalls and replacing flawed examples with safe idioms.
- Structuring Bash with small functions, clear variables, predictable output, and maintainable command options.
- Improving operator-facing terminal UX with progress indicators, colors, prompts, notifications, or menus.
- Converting ad hoc command sequences into maintainable Bash.
- Deciding whether Bash is still appropriate or a real language is needed.

## Avoid when
- The task targets POSIX `sh` portability instead of Bash.
- The script needs complex JSON/YAML parsing, business logic, or data structures beyond arrays.
- The user is debugging interactive ZSH/fish configuration rather than a script.
- A safer existing project tool already owns the workflow.
- The requested interactivity would make CI/non-interactive execution fragile unless a non-interactive mode is also provided.

## Instructions
1. Prefer `#!/usr/bin/env bash` and add `set -euo pipefail` for non-trivial scripts.
2. Name script positional args immediately with `readonly` variables and `${1:?Usage: ...}` where useful; bind function args to named `local` variables.
3. Quote variable expansions by default, prefer `${var}` form, and use `[[ ... ]]` for Bash conditionals.
4. Treat filenames as hostile data: never parse `ls`; avoid raw `for x in $(find ...)`; handle leading dashes with `--` or `./` prefixes; use NUL-delimited `find -print0`/`xargs -0` or `find -exec ... {} +` when paths may be arbitrary.
5. Use arrays instead of space-delimited strings; local variables lowercase, exported env vars UPPER_CASE.
6. Prefer `$(cmd)` over backticks, `printf` over `echo`, and long command options when readability matters.
7. Use small single-purpose functions; extract complex tests into named predicate functions.
8. Use the right conditional form: `if command; then` for command status, `[[ ... ]]` for Bash string/pattern tests, and `(( ... ))` for arithmetic only after validating untrusted numeric input.
9. Handle heredocs and privileged writes deliberately: quote heredoc delimiters when no interpolation is wanted; use `printf ... | sudo tee file >/dev/null` for elevated writes.
10. Add scoped tracing only when requested or gated behind `TRACE=1`; never trace secrets.
11. Use cleanup traps for temp resources; preserve the original exit code and make cleanup tolerant.
12. Make team/CI scripts idempotent where practical: check before acting.
13. Add simple logging helpers for scripts with multiple steps; warnings/errors go to stderr.
14. Do not read and write the same file in one pipeline; use a temp file plus `mv` or a known-safe in-place tool.
15. Do not use `cmd1 && cmd2 || cmd3` as general if/else unless `cmd2` cannot fail.
16. For user-facing scripts, add terminal UX only when it improves operability: spinners/progress for long-running tasks, colors only when stdout is a TTY, prompts only in interactive mode, and desktop/GUI notifications only behind optional dependency checks.
17. Always provide a quiet/non-interactive path for CI (`CI`, `NO_COLOR`, `--yes`, `--no-progress`, or similar).
18. Stop and recommend Python/another language when Bash becomes complex, long-lived, deeply nested, or data-heavy.

## Progressive disclosure
- Read `references/modern-bash.md` for strict-mode patterns, terminal UX guidance, and stop-using-Bash criteria.
- Read `references/bash-cheatsheet.md` when reviewing readability, function structure, output/redirection, heredocs, or debugging practice.
- Read `references/bash-pitfalls.md` before copying examples from the web or when reviewing filename handling, tests, pipelines, arrays, arithmetic, `sudo`, `find`, `xargs`, or strict-mode behavior.
- Use `evals/trigger-prompts.json` when refining trigger behavior.
- Use `evals/evals.json` when checking output quality for Bash script generation or review.

## Output
- Bash suitability verdict.
- Key safety/design choices.
- Pitfalls checked or intentionally not relevant.
- Script or patch.
- Validation: syntax check, ShellCheck if available, and any dry-run/manual checks.
- Interactive/CI behavior notes for user-facing scripts.
- Risks and when to migrate away from Bash.
