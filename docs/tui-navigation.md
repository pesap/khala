# TUI navigation

Interaction sustains agency by showing what changed, what needs a decision, and what can happen next.
This document owns the target Pi interaction from the [MVP design](mvp-design.md).
The current interface still has separate Actions, Peer-Review, and Archive views; those are not the target layout described below.
[Architecture](architecture.md#commands-and-reads) owns the read/action boundary, and [Data model](data-model.md#current-projections-and-attention) owns saved attention facts.

## Quiet and on demand

`/khala` opens only when requested and emits no child-session traffic into the User conversation.
The interface is one plain Pi-native text panel, not a dashboard or separate application shell.
It retains Pi's editor, theme, and normal footer, adding only a compact Khala status when available.
Use plain rows, visible selection, and consistent navigation without cards, sidebars, permanent split panes, or nested modal stacks.
Role settings change Khala's persisted configuration, never the User's active model or settings.

## Find Work

Work, Needs attention, Review, and History are filters over the same Work summaries, not separate domain objects.

| Filter | Shows |
| --- | --- |
| Work | Nonterminal Work |
| Needs attention | Unresolved requests and operations plus unacknowledged terminal failures |
| Review | Work awaiting User review |
| History | All terminal Work |

Rows show title, current status, and enough repository/worktree identity to distinguish assignments.
Internal IDs and Execution states do not lead the view.
Selection stays bound to the stable Work ID when status changes or the Work leaves the current filter.
The footer uses a small summary read rather than loading every Work.

## Understand and act

The selected Work shows its goal, current input request when present, current activity or stop reason, latest meaningful result, and available actions.
An input request's reason and permitted response precede generic status and technical metadata, including before a Mission exists.
Actions sit beside the information explaining them, not in a required separate Actions panel.
The service supplies revision-bound actions and confirmation requirements; the UI does not infer authority from labels or scan arbitrary records for questions.

Resolving a request or reconciling an operation clears that attention reason.
The User can acknowledge a terminal failure without removing History or concealing other unresolved operations.
A recorded acceptance waiting for budgeted Conclave settlement is shown as “accepted, awaiting settlement”, not as completed Work.

Review details expose the reviewed base and head, commits, checks, feedback, and provider link when present.
Local delivery offers a bounded on-demand diff against the recorded base; provider delivery may also use its PR/MR for full review.
Acceptance identifies the exact review snapshot and follows the [lifecycle rules](lifecycle.md#acceptance-and-settlement).
Provider delivery does not add a second acceptance confirmation in Pi.

Evidence is a filtered Archive-history view with an All records option, not a second history system.
Record bodies, full terms, attempt bindings, budget, model, workspace, and prompt details load only on inspection.
Guidance is inspectable with its sources and applicability, not injected into every screen.
Settings stays separate and shows effective role defaults; existing attempts retain recorded configuration.
Empty values and sections are omitted.

## Keyboard and drafts

The following describes navigation roles; hints use Pi's configured bindings rather than new global letter shortcuts.

| Key | Navigation |
| --- | --- |
| Left / Right | Switch peer panels or list filters |
| Up / Down | Move selection or scroll text |
| Enter | Open an item or choose an explicit action |
| Escape | Return one level; close Khala at the root |

Text input uses normal Pi multiline editing, including paste, blank lines, cursor movement, and configured editor bindings.
List navigation is inactive while editing.
Leaving the editor preserves the draft and returns to explicit Submit and Discard actions.
Typing, inserting a newline, accepting a field, or navigating away never submits a decision or cancels Work.

Submission and consequential confirmations are explicit actions.
Preserve draft fields and selection across navigation, refresh, errors, and revision conflicts.
Returning from Khala restores the existing Pi editor draft.
Status uses text as well as color.
Long details scroll without forcing technical metadata into the primary view.

## Freshness, disconnection, and recovery

Opening Work reads saved state without probing runtime, polling a provider, or scanning historical records.
Archive and Evidence begin with one bounded page of up to 100 records.
Runtime checks and refresh are explicit operations with cancellable waiting and visible freshness or unavailability.
Navigation never writes lifecycle records or launches agents.

Disconnected views retain clearly labelled saved data rather than claiming mutations succeeded.
The client retains pending command identity and exact input, then queries or retries that same command under the [application contract](architecture.md#commands-and-reads).
A revision conflict preserves the draft and requires rereading state, not replaying a new decision automatically.
Delayed responses cannot reopen a dismissed panel, move selection, or overwrite newer data.

Requested, running, and confirmed results are visibly distinct.
An accepted recovery operation has durable status; leaving its progress panel stops waiting, not the operation.
Escape dismisses the recovery panel without cancelling backend recovery, and late results do not reopen it.
Offer operation cancellation only when the backend can honor it.
Leaving a view is always distinct from cancelling Work.

## Current interface reference

The current picker switches Work, Needs attention, Review, and terminal History filters with Pi's configured left/right editor bindings when search is empty.
Work keeps failed Work visible while hiding succeeded and cancelled Work by default.
The configured history shortcut additionally toggles all Work, including active Work.
Needs attention currently includes failed Work, input requests, and blocked Executions; acknowledgement of terminal failures remains a backend requirement.
Work overviews show the goal, blocker, next action, saved revision, section navigation, and enabled revision-bound actions.
Actions remains available as a dedicated chooser, but is not required to invoke an action.
Page Up and Page Down scroll overview details while action navigation stays visible on short terminals.
These entry points also support the [current getting-started workflow](getting-started.md).
Current configurable shortcut names and defaults are listed in [Operations](operations.md#current-configuration-reference).

Current Archive reads retain one page of up to 100 records, newest first.
Older records continues the same snapshot; Newest records starts a fresh snapshot without retaining previous pages.
Cancelling a history read keeps the previous page or returns to the overview when no page has loaded.
Peer-Review reads comments from the saved latest provider observation without scanning history.
A latest observation without comments is shown as unavailable rather than inferred from unrelated records.
Runtime capability and process-ownership secrets are omitted.
Multiline action drafts use a separate Pi Editor and remain available while Khala is open.
Escape leaves editing without submitting; Submit, Discard, and consequential confirmation are explicit choices.
An unknown command result retains its exact identity, input, and revision for an explicit retry.

## Checks before relying on interaction

Complete submission, clarification, review, correction, and acceptance with the keyboard alone.
Paste multiline feedback with blank lines, navigate away and return, and preserve it after errors and revision conflicts.
Dismiss a pending read and recovery panel, then verify late responses cannot reopen them or imply cancellation.
Lose a committed mutation response and reconnect without issuing a duplicate decision.
Verify attention acknowledgement preserves History and that status remains understandable without color.
