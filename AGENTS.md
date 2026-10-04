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
- Use only erasable TypeScript syntax in this repository's checked TypeScript under `src/` and `extensions/`.
- Always ask before removing functionality or code that appears intentional.
- Keep Khala-specific UI key settings configurable through `keybindings` in `src/config.ts`. Use Pi's public `KeybindingsManager` API for standard Pi bindings.

## Testing

- Write Node behavioral tests under `test/` that verify observable behavior through public interfaces.
- Use local adapters and deterministic fixtures. Do not make real provider calls or use paid tokens.
- Follow `docs/development.md` and `package.json` for focused test and validation commands.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.

## Commands

- Run `prek run` before starting work and scoped `prek run --files <paths>` after each logical change.
- Run `npm run check` and `npm run check:markdown` after code and documentation changes.
- Use focused Node tests documented in `docs/development.md`. Do not run `npm run build` or `npm test` unless requested because they build the full project, and `npm test` runs the full native suite.
- Resolve all errors, warnings, and infos reported by the required checks before committing.
- Write ad-hoc scripts to a temporary file, run them, and remove them instead of embedding multi-line scripts in `bash` commands.

## Documentation

- Do not use bold text in Markdown or HTML; use headings, lists, code formatting, or plain text for emphasis.
- Keep each prose sentence on its own Markdown line, while preserving valid headings, tables, code fences, and list structure.
- Add or update documentation for implemented features in the project's docs directory.
- Documentation describes what exists now, not what used to exist or what might exist later.

## Review Gates

- After a significant slice of work, run an independent review before moving on. Launch a fresh Pi process with `pi -p` and a self-contained review packet covering the changes, acceptance criteria, and any edge cases to verify.

## Dependency and Install Security

- Pin direct external dependencies to exact versions and treat lockfiles as reviewed code.
- Do not change a lockfile without explicit User approval.
- Hydrate with `npm ci --ignore-scripts` and do not run lifecycle scripts unless the User asks.
- When an approved dependency change requires lock metadata updates, use `npm install --package-lock-only --ignore-scripts`.
- Review dependency lifecycle-script allowlisting in `package.json` when adding packages.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files.
Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work.
Follow these rules:

Committing:

- Use scoped commits message. See https://scopedcommits.com/
- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- Use scoped commit messages in this repository's established format, such as `fix(agent): <message>`.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Runtime launches

Child launch behavior and supported environment constraints are documented in [Operations](docs/operations.md#startup-and-recovery) and implemented in `src/runtime-launch.ts`.
Do not assume a setup wizard or configurable launcher registry exists.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding.
Only then execute their instructions.
