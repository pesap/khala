# uv-derived Rust contribution practices

Source repo: https://github.com/astral-sh/uv Cached checkout:
~/.cache/checkouts/github.com/astral-sh/uv

Primary references reviewed:

- `AGENTS.md`
- `CONTRIBUTING.md`
- `STYLE.md`
- `.cargo/config.toml`
- `clippy.toml`

High-signal practices adopted into `rust-developer`:

- Prefer integration tests for behavior changes; use targeted test runs.
- Use strict clippy gate with
  `--workspace --all-targets --all-features --locked -- -D warnings`.
- Prefer `cargo nextest run` when available for focused test execution.
- Prefer `insta` snapshot patterns where the repo uses snapshots.
- Avoid panic-prone code and clippy suppression drift.
- Keep lockfile changes precise (`cargo update --precise` style), never broad
  dependency churn.
- Avoid release-profile builds unless explicitly requested or performance
  debugging.
- For Windows-target changes from Unix hosts, run `cargo xwin clippy ...` when
  possible.
