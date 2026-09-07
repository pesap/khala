# Attention summaries

An attention summary explains why Work needs a decision and what can happen next.
It is not another lifecycle or a replacement for saved evidence.

The authoritative rules are split by responsibility:

- [Data model](data-model.md#current-projections-and-attention) defines the durable facts, resolution, and acknowledgement behind attention.
- [Lifecycle](lifecycle.md) defines the authorized response to clarification, blocked work, rejection, and failed operations.
- [TUI navigation](tui-navigation.md#understand-and-act) defines how those reasons and actions appear beside the Work.
- [Architecture](architecture.md#commands-and-reads) defines the bounded read and action contract used by the view.

## Wording

Use a concise reason and a concrete next action rather than an internal state dump.
Examples of target presentation include:

- “Validation could not run. Inspect the failure before choosing how to continue.”
- “The assignment needs another path. Review the proposed Mission terms.”
- “Accepted, awaiting settlement. Increase the Work budget to allow settlement.”
- “Writer termination is unconfirmed. The workspace remains reserved.”

These examples illustrate presentation, not strings for the UI to parse into authority.
Selection, editing, history, and navigation have one home in the interaction contract rather than a second layout specification here.
