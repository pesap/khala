# Bash pitfalls: do-not-follow examples

Source: https://mywiki.wooledge.org/BashPitfalls

Use this reference when writing or reviewing Bash that touches filenames,
quoting, tests, pipelines, arrays, redirection, `sudo`, `find`/`xargs`,
arithmetic, or strict mode. Treat examples on the source page as flawed unless
explicitly marked as the corrected form.

## High-risk patterns to reject

- Do not parse `ls` or raw `find` output with `for f in $(...)`; use globs,
  `find -exec ... {} +`, or NUL-delimited `find -print0` with
  `while IFS= LC_ALL=C read -r -d ''`.
- Do not leave expansions unquoted: avoid `cp $file $target`, `echo $foo`,
  `[ -n $foo ]`; quote or use `[[ ... ]]` where appropriate.
- Do not forget option terminators or safe prefixes for filenames that may start
  with `-`: prefer `cmd -- "$path"` or `./`-prefixed globs.
- Do not use `[ ... && ... ]`; either compose separate `[ ... ] && [ ... ]`
  commands or use `[[ ... && ... ]]`.
- Do not use `[[ $x > 7 ]]` for numeric comparison; use `(( x > 7 ))` after
  validating untrusted numeric input.
- Do not depend on variable changes inside pipeline-fed loops; pipelines may run
  loop bodies in subshells. Use process substitution when state must persist.
- Do not wrap commands in test brackets: use `if grep -q pattern file; then`,
  not `if [grep ...]`.
- Do not read and write the same file in one pipeline; write to a temp file and
  `mv`, or use a tool's safe in-place mode knowingly.
- Do not use `cmd1 && cmd2 || cmd3` as a general if/else replacement; use
  `if ...; then ...; else ...; fi` unless `cmd2` cannot fail.
- Do not iterate arguments with `$*`; use `for arg in "$@"` or `for arg`.
- Do not combine `local var=$(cmd)` when exit status matters; split into
  `local var; var=$(cmd); rc=$?`.
- Do not pass variables as `printf` formats: use `printf '%s\n' "$value"`.
- Do not populate arrays with raw command substitution: avoid `arr=( $(cmd) )`;
  use `readarray -t`, `read -ra`, or NUL-safe reads depending on data shape.
- Do not use `xargs` on filenames without `-0`; pair `find -print0` with
  `xargs -0`, or use `find -exec ... {} +`.
- Do not inject `{}` directly into `sh -c` code from `find`; pass found paths as
  positional arguments.
- Do not assume `sudo cmd > file` elevates redirection; use
  `cmd | sudo tee file >/dev/null` or a deliberate `sudo sh -c` wrapper.
- Do not close stdio as shorthand for discard; redirect to `/dev/null` instead.

## Strict-mode nuance

- `set -euo pipefail` is useful but not magic. `errexit` and `pipefail` have
  surprising contexts; still check critical commands explicitly.
- Be careful with `pipefail` around short-circuit readers like `grep -q`, which
  may stop early and cause upstream SIGPIPE.
- Use ShellCheck and targeted tests to catch many of these pitfalls, but still
  reason about data shape and command semantics.

## Review checklist

- Are all path-like expansions quoted and protected from leading-dash filenames?
- Are list inputs NUL-safe where filenames may be arbitrary?
- Are conditionals using the correct Bash construct for strings, patterns,
  regex, and arithmetic?
- Is any command output being parsed when a safer API/option exists?
- Are redirections ordered correctly and evaluated by the intended user?
- Does strict mode hide any missing explicit error checks?
