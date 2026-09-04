# UI and code-quality review

This review records the current UI and implementation quality baseline for Khala.
It summarizes the implemented lifecycle, runtime, provider, TUI, and extension safeguards, plus the bounded follow-up work that remains.

## Implemented fixes

### Lifecycle and archive

- Provider outcome settlement now requires a live Mission, so a rejected Mission cannot become succeeded.
- Provider polling rejects terminal Work instead of mutating terminal projections.
- Queued Work receives a Conclave wake after a budget amendment.
- Unknown runtime states are recoverable for Executor and Observer bindings.
- Feedback effects carry their originating Execution and are superseded rather than delivered to a replacement.
- Replacement Executions clear the current failure marker while retaining historical error records.
- Command replays validate the actor and command fingerprint and return the projection captured by the original command, including a replacement Verdict's resulting Execution.
- Submit command reuse conflicts are reported as invalid input rather than external failures.
- Unsupported outbox effects are completed so one corrupt effect cannot starve the queue, after durable diagnostic evidence is recorded.
- Cleanup failures create durable error evidence and leave cleanup retryable; successful retries clear the cleanup attention state.
- Autonomous monitoring runs Work inspections concurrently and exposes service-wide monitor failures without attaching them to an arbitrary Work.
- Background effect drains attach rejection handlers.

### Runtime and workspace boundaries

- Executors no longer receive arbitrary `bash` access.
- Executors commit changes with `commit-sandbox` and run declared validation with `run-validation`.
- Ready Signals require nonempty evidence and current successful validation.
- Direct file-tool path checks resolve existing symlink components before allowing a path, require file-tool paths, and fail closed when the Executor scope is incomplete.
- Sandbox creation and reuse reject symlinked parents, symlinks, and unregistered Git worktrees.
- Allowed paths reject traversal and Git pathspec syntax before governed commits.
- Git workspace and validation commands remove credential-shaped environment variables before launch.
- Child runtimes remove credential-shaped environment variables before launch.
- Child runtimes disable ambient extension discovery and load only the explicitly supplied Khala extension.
- Ephemeral sessions use runtime-owned paths and reject a child-reported session file outside that path.
- Failed RPC turns kill the child rather than allowing late events to affect a later turn.
- RPC buffers, assistant output, Oracle packets, and validation output have explicit limits.
- Validation commands run in owned process groups so cancellation and timeout cleanup includes descendants.
- macOS process ownership uses `ps` when `/proc` is unavailable.
- Provider command buffering is raised enough for bounded parsing to handle large valid responses.
- Provider state and check parsing rejects unknown or contradictory status data.
- Runtime and configuration locks use atomic ownership and do not replace live owners based on age alone.
- Child startup requires the parent-provided project, trust, and role authority instead of generating a new authority.
- Target branches and branch prefixes receive Git-ref validation during configuration loading.

### Provider feedback

- Trusted GitHub reviewers are actionable without requiring the reviewer to be the pull-request creator.
- Empty review records are excluded from conversation evidence.
- Provider comments are ordered newest first before bounded retention, so recent feedback is not hidden behind older comments.
- Feedback carries provider commit metadata and stale-head or wrong-repository comments are retained as non-actionable evidence without creating duplicate observations after restart.
- Peer-Review remains separate from Evidence and retains the review location and source URL.

### TUI and user experience

- The Work picker has configurable refresh, history, and help controls.
- Refresh rereads Work while preserving the current selection and filter.
- Completed and cancelled Work can be inspected through the history toggle.
- Failure summaries are textually visible in the Work overview rather than relying on color.
- Detail pages support scrolling with Up/Down, Page Up/Page Down, Home, and End.
- Recovery failures show the error code, summary, remediation, and evidence references.
- GitHub and GitLab requests are labelled PR and MR respectively.
- Filter and model-selector wrappers forward focus to their nested controls.

## Intentionally bounded behavior

- Validation is executed only from the User-declared validation list; Khala does not infer additional validation commands.
- A sandbox with `package-lock.json` hydrates its own dependencies through `npm ci --ignore-scripts` before governed commits and validation.
- GitLab status and merge observation are supported, but GitLab comment normalization is outside the current provider adapter.
- The bundled runtime uses process groups for child cleanup; Windows orphan recovery remains platform-dependent because Windows has no equivalent process-group signal behavior.
- Archive transition invariants remain enforced by the application service; startup validates schema version, table columns, foreign keys, record metadata, record numbering, outbox rows, and full projection invariants.
- The picker defaults to active Work to keep the primary view small; history is an explicit user choice.

## Remaining bounded follow-up

- Windows cannot use the Unix process-group signal path for an unattached child binding; cleanup fails closed by retaining the lease when termination cannot be confirmed.
- Selectors use fixed item windows because the Pi custom-component contract does not expose terminal height to the picker factory; detail pages use the real ScrollView layout path.
- Direct low-level Archive consumers still rely on the application service for lifecycle transition policy; the Archive itself validates projection shape, references, and budget invariants.
- GitLab comment normalization remains outside the current provider adapter.

## Verification

Run the repository checks after changes to lifecycle, runtime, provider, TUI, or extension behavior.

- `prek run --all-files`
- `npm run check`
- `npm run test`
- `npm run check:markdown`
- `npm pack --dry-run`

The test suite covers governed commit and validation actions, symlink rejection, credential filtering, late RPC behavior, command replay, provider reviewer identity, provider comment retention, lifecycle recovery, and picker refresh/history/help.
