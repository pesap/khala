# CLI UX principles

Sources:

- https://robinwinslow.uk/a-terminal-users-thought-process
- https://www.lucasfcosta.com/blog/ux-patterns-cli-tools
- https://afixt.com/accessible-by-design-improving-command-line-interfaces-for-all-users/
- https://www.tdcommons.org/dpubs_series/5129/
- https://seirdy.one/posts/2022/06/10/cli-best-practices/

## Terminal user journey

- Users often try: install through a package manager, verify command discovery
  with tab completion, run a first documented command, then explore using
  completion, `--help`, `help`, man pages, or web search.
- Support this path directly: easy install notes, shell completions, clear
  command names, useful no-arg behavior, and fast help on every subcommand.
- Use long options in docs for readability; short flags are for experienced
  repeated use.

## Time to value and discoverability

- Lead with common first commands and examples, not only exhaustive reference
  text.
- Make command trees consistent: same verbs, nouns, and flags should mean the
  same thing everywhere.
- Interactive flows can teach and constrain choices, but they must have
  equivalent non-interactive flags/config for automation.
- Suggest likely commands after typos or invalid inputs when confidence is high.

## Errors and recovery

- Errors should say what happened, why it likely happened, whether the tool or
  environment is at fault, and what to try next.
- Stable error codes can make documentation and search easier.
- Validate as early as possible; do not make users complete a long flow before
  reporting invalid input.
- Include debug/log file paths when useful, but keep the primary message
  human-readable.

## UNIX citizenship

- stdout is for data; stderr is for diagnostics, progress, warnings, and errors.
- Accept stdin where it makes composition natural.
- Exit `0` on success; non-zero on failure. Distinguish user input errors,
  environment errors, and internal errors when useful.
- Provide stable machine output (`--json`, `--yaml`, `--porcelain`, or stable
  line format) when users will parse output.
- Treat CLI arguments and stable output as public APIs; avoid breaking them
  without versioning/migration.

## Accessibility and plain output

- Prefer boring, linear, readable output by default. Output may be consumed by
  humans, scripts, logs, screen readers, braille displays, or parsers.
- Avoid ASCII art, decorative borders, tables that only make sense visually, and
  redraw-based animation unless optional.
- Honor `NO_COLOR`, `TERM=dumb`, non-TTY output, CI, and explicit flags like
  `--no-color`, `--color=auto|never|always`, `--no-animation`, `--plain`, or
  `--a11y`.
- Color and emoji must reinforce text, not replace it. Never rely on color
  alone.
- Prefer static progress lines or numeric percentages over spinners for
  accessible output.
- Provide structured output endpoints for assistive tooling when output is
  complex.
- Test important output by redirecting it, piping it through simple tools, and
  listening with a screen reader or text-to-speech when possible.

## Documentation and completions

- Provide `-h`/`--help` on main command and subcommands.
- Write man pages when shipping broad Unix-like tools; include `SEE ALSO` for
  config formats or related commands.
- Make `whatis`/`apropos` useful through clear one-line summaries.
- Add shell completions where practical, including option help when supported.
- Include examples and expected output; consider using them as golden tests.

## Safety

- Commands should do only what their names imply; avoid surprise network,
  filesystem, or telemetry side effects.
- Destructive operations need `--dry-run`, preview, explicit confirmation, or a
  reversible default.
- Default to minimal output for scripts and clear output for humans; allow
  verbosity flags rather than noisy defaults.

## Review questions

- Can a new user discover the first useful command in under a minute?
- Can an expert automate the same action without prompts?
- Is output still useful when redirected to a file, piped to `grep`, or read by
  a screen reader?
- Are errors actionable without searching the web?
- Are command names, flags, streams, exit codes, and output formats stable
  enough to script against?
