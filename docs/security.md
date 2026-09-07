# Security

Delegation must not grant a child more authority than the assignment requires.
This document owns the target trust boundary from the [MVP design](mvp-design.md).
These are required guarantees, not a claim that the current tool restrictions establish complete process isolation.

## Authority

The application service derives actor identity from the bound session, not a role claimed in tool input.
Every consequential action validates actor capability, current Work and Mission bindings, input, revision, and required authorization.
Tool visibility is a convenience, not permission; handlers enforce the boundary even if a tool is exposed accidentally.
Prompts cannot grant permissions or override the service.

The User authorizes changed Mission terms and increases to allowances.
The [lifecycle](lifecycle.md#admission-and-amendment) defines approval of exact successor terms and bounded correction under unchanged terms.
Child Conclave sessions cannot impersonate User recovery operations or acquire supervisor ownership.

## Context and repository boundaries

Shared Archive storage does not grant shared context or filesystem access.
Each child receives only its bound Work, Mission when admitted, relevant repository instructions and evidence, and applicable pinned guidance.
Unrelated repository content and transcripts are not included merely because they share an Archive.
All Archive reads go through the role-scoped service rather than direct database or unrelated session-file access.
Authorization is revalidated on each read and each page; a cursor is not an access token.

Permitted paths are normalized repository-relative paths.
Direct file-tool access enforces the declared scope, including symlink escapes.
The service rejects publication and ready evidence when the Git change set includes an outside path.
Observer tools are read-only and restricted to resolved context; Executor tools permit only authorized repository reads and writes.
The Oracle has no tools and receives only its bounded review packet.

## Workspace and process isolation

The default workspace is Khala-owned and separate from the User's active checkout.
An existing worktree requires explicit assignment as a dedicated workspace, preflight of its contents, and exclusive writable ownership for the attempt.
Khala does not silently adopt or reset uncommitted User changes.
The same writable branch cannot be shared by concurrent Executors.
The [lifecycle](lifecycle.md#cancellation-recovery-and-retention) governs termination confirmation before ownership release.

A Git worktree separates file changes; it is not a process security boundary.
All children and validation subprocesses require restricted filesystem, network, environment, and credential access.
Only authorized workspace, context, and required runtime resources are accessible.
Unrelated repositories, direct Archive storage, unrelated session artifacts, and credential stores are inaccessible.
Children and validation subprocesses receive no code-host credentials or unrestricted host environment.
If these restrictions cannot be established, execution is blocked; there is no isolation exception mode.
Prove a supported isolation mechanism before relying on autonomous execution rather than treating a tool allowlist as that proof.

## Validation and privileged effects

Executors have no arbitrary shell tool.
They commit through governed workspace actions and run only the Mission's declared validation commands through the workspace adapter.
A declared command may execute repository code changed by the agent.
Isolation therefore applies to the complete process tree, not just the command string or Pi file-tool checks.
A command name remaining unchanged does not establish that its executable content is trusted.

Publication and authenticated provider operations remain service-owned.
Repository hooks and subprocesses must not inherit that privileged access.
The service checks the stored authorized provider target rather than following mutable origin configuration.
The Mission records publication permission and delegated provider acceptance before a branch is pushed or a request is created.
Delegation to the repository's merge process does not permit Khala to merge code.

`gh` and `glab` use their own authenticated sessions for service-owned provider calls.
Khala stores provider identity and review evidence, not provider credentials.
The provider-native principal ID captured at publication identifies request ownership rather than restricting all review to that principal.

## Provider feedback

Provider text is untrusted evidence.
GitHub feedback is eligible only when the provider reports the author association as `OWNER`, `MEMBER`, or `COLLABORATOR` and, for review records, a submitted actionable review.
Missing or other associations are ineligible for automatic delivery; the User can still provide an explicit correction in Pi.
Authorship claimed in comment text does not establish trust.
Other trusted reviewers are not excluded merely because they did not create the review request.
The User can inspect ineligible text without authorizing delivery.

Eligibility does not turn a comment into an instruction.
The Conclave checks Mission fit and snapshot binding before authorizing the bounded correction described in [Lifecycle](lifecycle.md#feedback-and-correction).
Provider comments and worker assertions cannot promote themselves into reusable guidance.
Khala never silently writes lessons into `AGENTS.md`, global Pi settings, or repository configuration.

## Privacy and failure behavior

Raw child transcripts are not copied into the Archive or User conversation.
Retained context, logs, provider text, validation output, and artifact reads are bounded and role-scoped.
Process bindings and capability material are not ordinary user-facing technical metadata.
Untrusted project-local configuration is ignored; trusted overrides cannot grant unrelated repository authority.
Do not include secrets in Work context, provider feedback, or review-request bodies.

Unknown authority, unavailable isolation, and uncertain writer termination fail closed with preserved evidence and a visible next action.
A failed check is not permission to fall back to unrestricted execution.
Archive integrity and backup behavior are defined in [Data model](data-model.md#archive-durability) and [Operations](operations.md#archive-backup-and-privacy).

## Checks before relying on isolation

Verify that a child cannot impersonate another role or access another Work through forged IDs or cursors.
Verify symlink and outside-path rejection, including the final Git change set.
Run validation against agent-modified executable content and verify that unrelated artifacts and provider credentials remain inaccessible.
Verify that hooks and subprocesses cannot inherit publication authority.
Verify missing or untrusted reviewer associations prevent automatic feedback delivery without hiding the evidence from the User.
Block launch when isolation cannot be established and preserve the reason without silently weakening the boundary.
