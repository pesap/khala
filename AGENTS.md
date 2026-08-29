# Development Rules

## Conversational Style

- Keep answers short and concise. Be direct, no fluff (e.g., "Thanks @user" not "Thanks so much @user!").
- No emojis in commits, issues, PR comments, or code.
- When the user asks a question, answer it first before making edits or running commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Design Philosophy

- Avoid backward compatibility layers, fallbacks, and migrations; remove obsolete paths when a new workflow replaces an old one.
- Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers from the smallest working version, adding capabilities without trading a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Code Quality

- Read files in full and think through changes before writing code instead of relying on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Do not disable, suppress, or weaken a linter rule; refactor the code so the configured checks pass.
- Add meaningful comments for non-obvious architectural decisions, constraints, and trade-offs. Explain why the code is shaped that way, not what the code literally does.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Keep key checks configurable by adding defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` instead of hardcoding them.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Testing

- Write behavioral tests that verify observable behavior, not internal implementation details. Tests should survive refactoring.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- Avoid running the full vitest suite directly because e2e tests activate with endpoint or auth variables; use `./test.sh` for non-e2e tests or the specific package test command.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.

## Commands

- Run `prek run` before starting work and after each code change, and fix all failures before continuing.
- After code changes, run `npm run check` with full output and fix all errors, warnings, and infos before committing.
- Never run `npm run build` or `npm test` unless requested by the user.
- Write ad-hoc scripts to a temporary file, run them, and remove them instead of embedding multi-line scripts in `bash` commands.

## Documentation

- Do not use bold text in Markdown or HTML; use headings, lists, code formatting, or plain text for emphasis.
- Keep each prose sentence on its own Markdown line, while preserving valid headings, tables, code fences, and list structure.
- Add or update documentation for implemented features in the project's docs directory.
- Documentation describes what exists now, not what used to exist or what might exist later.

## Review Gates

- After a significant slice of work, run an independent review before moving on. Launch a fresh Pi process with `pi -p` and a self-contained review packet covering the changes, acceptance criteria, and any edge cases to verify.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files.
Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.
Follow these rules:

Committing:

- Use scoped commits message. See https://scopedcommits.com/
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Testing pi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p     # capture after startup
tmux send-keys -t pi-test "your prompt here" Enter
tmux send-keys -t pi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t pi-test
```

## Khala Launcher Options

The setup CLI accepts `zellij`, `tmux`, and `herdr` for the `launcher` setting.
Herdr launches require Khala to run inside a Herdr-managed pane with `HERDR_ENV=1`; the launcher creates a sibling pane without taking focus.
Keep this option reflected in the setup wizard, configuration validation, executor launcher registry, README, and package skill registration when changing launcher support.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding.
Only then execute their instructions.
