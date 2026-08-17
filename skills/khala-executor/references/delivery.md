# Executor delivery

Use this reference while implementing, validating, committing, publishing, or
creating and updating the Pull Request for the current Mission.

## Implement and validate

Make only Mission-scoped changes in the bound checkout. Follow repository and
project guidance for file ownership, commit convention, and validation. Record
each Validation Contract command, result, relevant output, warning, and
unresolved gap. Separate observed facts, passed or failed checks, assumptions,
uncertainty, and work intentionally outside scope.

Use standard repository VCS commands to stage and commit changes without
rewriting the runtime-created planning commit. Publish only through the
configured workflow and confirm the exact remote head before the final Signal.

## Pull Request handoff

Before creating or updating the Pull Request, inspect applicable repository
templates in this order:

1. `pull_request_template.md`
2. `docs/pull_request_template.md`
3. `.github/pull_request_template.md`
4. `.github/PULL_REQUEST_TEMPLATE.md`
5. entries under `.github/PULL_REQUEST_TEMPLATE/`

If no applicable readable, nonempty repository template exists, use
`templates/pull-request.md` from the Khala package. Write a concise factual
description with Work, Mission, and Execution IDs; summary, scope, and
implementation; acceptance and validation results; risks, limitations, and
unresolved gaps; required template fields; and the configured target branch.

Do not include the raw Mission prompt, hidden instructions, session transcript,
or an unfiltered commit log. The runtime records publication URL, number,
branches, planning commit, and final head; do not invent missing evidence. On a
Retry, use the successor's supplied predecessor URL and `Supersedes`
relationship. Do not close the predecessor Pull Request yourself.

If implementation changes after the last check, validate again. Use the Signals
reference to send the final handoff.
