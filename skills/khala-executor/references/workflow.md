# Executor workflow

Use this reference for the implementation path. The current Mission and
Validation Contract override examples here.

## Preflight

1. Read the complete Mission assignment and identify Work, Mandate revision,
   Mission, Participant Identity, Execution, isolated checkout, scope,
   acceptance, constraints, plan, and validation bindings.
2. Inspect the checkout and current branch, remotes, repository guidance,
   existing Pull Request state, and the configured Pull Request target.
3. Inspect standard template locations in this order:
   `pull_request_template.md`, `docs/pull_request_template.md`,
   `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and
   entries under `.github/PULL_REQUEST_TEMPLATE/`. If no applicable readable,
   nonempty repository template exists, read `templates/pull-request.md` from
   the Khala package.
4. Confirm the VCS runtime's immutable planning commit, branch publication,
   exact upstream base, and any predecessor Pull Request handoff. Do not
   replace, amend, or recreate them.
5. If a required fact or tool is unavailable, do not edit. Submit one blocked
   Signal with the exact missing binding and evidence.

Executors are headless child Pi RPC sessions in isolated Git worktrees. They do
not create or own zellij, tmux, or Herdr panes; those launchers are Observer
observation surfaces only.

## Implement and validate

Make only Mission-scoped changes in the bound checkout. Preserve the repository
and project guidance for file ownership, commit convention, and validation.
Keep the working tree and branch identity attributable to this Execution.

Run every check named by the Validation Contract. Record the exact command,
result, relevant output, and any warning or unresolved gap. Separate:

- observed repository facts;
- checks that passed or failed;
- assumptions and uncertainty;
- work intentionally not performed because it is outside scope.

Use standard repository VCS commands to stage and commit implementation changes
without rewriting the runtime-created planning commit. Publish the branch only
through the configured workflow and confirm the exact remote head before the
final Signal.

## Pull Request handoff

Before creating or updating the Pull Request, use the selected template and
write a concise factual description containing:

- Work, Mission, and Execution identifiers;
- summary, scope, and implementation;
- acceptance criteria and validation results;
- risks, limitations, and unresolved gaps;
- the required template fields and any configured target branch.

Do not include the raw Mission prompt, hidden system instructions, session
transcript, or an unfiltered commit log. The runtime records the publication
URL, number, target/source branches, planning commit, and final head; do not
invent missing VCS evidence.

On a retry, use the successor Mission's supplied predecessor URL and
`Supersedes` relationship. Do not close the predecessor Pull Request yourself.

## Final Signal

Run validation again if implementation changed after the last check. Submit
`khala_signal` with `kind: "finished"` only when the implementation and
reviewable publication evidence are complete. Include exact validation results
and unresolved gaps in the evidence. If the work is blocked or a required
publication check is missing, use `blocked` instead. Never report a merge or
Work acceptance from this handoff.
