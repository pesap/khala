# Modern Bash scripting reference

Sources:

- https://www.mechanicalrock.io/blog/modern-bash
- https://levelup.gitconnected.com/5-modern-bash-scripting-techniques-that-only-a-few-programmers-know-4abb58ddadad

## Defaults

- Prefer Bash for portable team/CI scripts; do not assume interactive ZSH
  features.
- Use `#!/usr/bin/env bash` when Bash location may vary; document Bash 4+
  requirements when using associative arrays, `mapfile`, etc.
- Use `set -euo pipefail` near the top for non-trivial scripts.
- Use `set -x` only for scoped debugging or behind `TRACE=1`; never trace
  secrets.

## Safety and readability

- Assign positional args to named `readonly` variables immediately.
- Use `${1:?Usage: ...}` for simple required arguments.
- Quote variable expansions by default: `"${value}"`.
- Use `[[ ... ]]` for Bash conditionals.
- Use arrays instead of space-delimited strings.
- Use lowercase for local variables and UPPER_CASE for exported env vars.

## Cleanup and idempotency

- Use a `cleanup` trap for temp files, containers, locks, and partial state.
- Capture the original exit code in cleanup and exit with it.
- Make cleanup tolerant with `|| true` for expected missing resources.
- Make team/CI scripts idempotent: check before creating/deleting where
  practical.

## Logging

- Prefer small `log::info`, `log::warn`, `log::error` helpers over ad hoc
  `echo`.
- Send warnings/errors to stderr.

## Terminal UX for operator-facing scripts

- Use spinners/progress indicators for long-running tasks when the script is
  attached to a TTY.
- Disable animations/progress in CI or non-interactive mode; expose
  `--no-progress` or honor `CI`.
- Use colors/styles sparingly and only when stdout/stderr is a TTY; honor
  `NO_COLOR`.
- Keep prompts explicit and safe; offer `--yes`, `--force`, or config flags for
  automation.
- Use desktop/GUI notifications only as optional enhancements after checking
  that tools like `notify-send`, `osascript`, or `zenity` exist.
- Prefer plain logs over clever UI for scripts that are mostly consumed by CI,
  other programs, or copied output.
- Do not let animation helper failures mask the real command exit code.

## Stop using Bash when

- You need JSON/YAML parsing or complex data structures.
- The script is becoming long-lived business logic.
- The script grows past roughly 200 lines or has deep function call chains.
- Maintainers are unlikely to know Bash well.
