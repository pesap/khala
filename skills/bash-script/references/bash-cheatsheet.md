# Bash clean-code cheat sheet

Source: https://bertvv.github.io/cheat-sheets/Bash.html

## Readability defaults

- Apply clean-code pressure to Bash: small functions, one responsibility,
  meaningful names, one abstraction level per function.
- Prefer long command options when available for maintainability, especially in
  scripts read by teammates.
- Use `${var}` form and quote expansions: `"${var}"`.
- Prefer `$(cmd)` over backticks.
- Prefer `printf` over `echo` for defined, portable output behavior.

## Variables and scope

- Prefer `local` variables inside functions.
- Make unavoidable globals `readonly`.
- Use UPPER_CASE only for exported environment variables; use lower_case for
  local script variables.
- Validate script positional parameters; bind function positional parameters to
  named locals for readability.
- Remember some loops run in subshells; do not rely on mutated variables after
  pipeline-fed loops.

## Output and redirection

- Send errors/warnings to stderr.
- Name heredoc delimiters by purpose, e.g. `HELPMSG`; single-quote the delimiter
  when interpolation must be disabled.
- With `sudo` plus redirection, pipe to `sudo tee` because shell redirection is
  not elevated.

## Functions

- Use functions to make Bash readable, not to hide control flow.
- Document non-obvious functions by arguments, return status, and stdout/stderr
  behavior.
- Extract complex tests into named predicate functions.

## Cleanup and debugging

- Use `trap` for cleanup and preserve the original exit status.
- Validate syntax with `bash -n script.sh`.
- Run ShellCheck and fix warnings when available.
- Use `bash -x` or scoped `set -x` only for debugging; avoid exposing secrets.
- Use logging to narrow failures; consider `bashdb` only for difficult cases.
