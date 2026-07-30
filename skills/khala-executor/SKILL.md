---
name: khala-executor
description: Execute one validated Khala Mission from preflight through reviewable pull request completion. Use when running as a Khala Executor or implementing a Work assigned by a Khala Mission.
---

# Khala Executor Workflow

This skill defines the detailed implementation procedure for the current Khala
Mission. The Executor system prompt remains authoritative for role, identity,
authority boundaries, isolation, and hard-stop rules. If this skill conflicts
with the system prompt, stop and follow the system prompt.

## Phase 1: validate and prepare

Every Khala Work requires a published Executor branch and a draft Pull Request.
A local-only handoff is not a valid completion path.

Before changing implementation files:

1. Read the complete first Mission message and identify Work ID, Mandate ID and
   revision, Mission ID, Participant Identity, checkout, scope, acceptance
   criteria, constraints, plan, and Validation Contract.
2. Inspect the checkout, current branch, remotes, repository guidance, existing
   pull request state, and standard repository Pull Request template locations:
   `pull_request_template.md`, `docs/pull_request_template.md`,
   `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and
   entries under `.github/PULL_REQUEST_TEMPLATE/`. Do not infer VCS or PR tooling
   from memory. If an applicable readable, non-empty repository template exists,
   use it; otherwise use `templates/pull-request.md` from the Khala package.
3. Resolve commit policy in this order: Work constraints, trusted project
   guidance, then User configuration. If no policy is specified, use
   Conventional Commits and the User-provided scope. Never silently override a
   more specific policy.
4. Verify the immutable planning commit prepared by the Khala VCS runtime before
   implementation. The runtime creates exactly one planning commit and pushes the Executor
   branch. Do not create a
   second planning commit, amend it, squash it, replace it, or include
   implementation changes in it.
5. The Executor owns Pull Request creation and description content. Inspect the
   repository's applicable Pull Request template, falling back to
   `templates/pull-request.md` only when no repository template exists. Use the
   authorized VCS/GitHub interface to open the draft PR after preflight, then keep
   it updated as implementation and validation change.
   The description must identify the Work, Mission, and Execution, then concisely
   describe the summary, scope, implementation, acceptance criteria, validation
   contract, planning commit, risks, and unresolved gaps. If the Mission includes
   a Khala Pull Request target branch, pass it as the PR base. Do not paste the raw
   Mission prompt, transcript, or commit log into the description.
6. If the runtime did not publish the branch or the required remote, credential,
   tool, or API is unavailable, stop and submit a blocked `khala_signal` with
   exact evidence. Never claim a PR exists or successful publication without
   command or API output.

## Phase 2: implement and publish

1. Implement only the current Mission in the isolated checkout.
2. Keep unrelated changes out of the branch.
3. Create small, reviewable commits using the resolved commit policy.
4. Push reviewable commits as meaningful slices are completed. Do not amend,
   rebase, squash, or force-push unless the effective policy explicitly allows
   it; force-push is forbidden by default.
5. Keep the draft PR description current when the implementation or validation
   plan changes, while preserving the selected repository or Khala template.

## Phase 3: retry and completion

For a retry, first inspect the existing PR description and messages, commits,
validation evidence, accomplished work, and stated failure reason. Summarize
what is already complete and what failed before continuing. Preserve the PR when
appropriate; follow the Conclave's successor-Mission policy otherwise.

Before completion:

1. Run every check in the Validation Contract and record exact results.
2. Push the final reviewable commits.
3. Update the draft PR using the selected template with implementation details,
   commit IDs, validation results, risks, and unresolved gaps. Keep it concise and
   factual. Do not merge it. Include the resulting PR URL and state in the final
   evidence.
4. Submit a final `khala_signal` containing branch, planning commit, implementation
   commit IDs, PR URL/state, validation evidence, and unresolved gaps.

A Signal reports evidence; it does not issue a Verdict or authorize work beyond
the current Mission.
