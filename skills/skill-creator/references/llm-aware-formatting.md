# LLM-aware formatting

Use this reference when a skill draft is noisy, over-formatted, hard to scan in
raw markdown, or likely to be read by weaker models.

LLMs read raw markdown, not rendered output. Every `**` pair adds 2 tokens with
no visual benefit to the model. Use formatting intentionally.

## Strong structural signals

Use these freely because they help the model parse hierarchy and data shape:

- `##` / `###` headings for document hierarchy
- `-` / `1.` list markers for sequences
- `|` tables for lookup data such as severity, thresholds, and trigger maps
- Code blocks for output templates, commands, schemas, and examples

## Marginal signals

Use these sparingly:

- `**term**` for the first definition of a key concept
- `**code**` for verdict labels such as `Approved`/`Rejected`
- One bolded procedural command per section when it is truly critical

## Formatting waste

Avoid these in skill files:

- Bold in table cells; the `|` delimiter already provides structure
- Bold on list-item labels; the list marker already separates label from value
- Bold for prose emphasis
- Bold on repeated mentions of already-defined terms
- Bold on column headers

## Token cost check

Each `**text**` costs 2 more tokens than plain `text`. Over a 200-line skill,
aggressive bolding can waste 50-80 tokens with little semantic gain. Spend those
tokens on concrete examples, output contracts, state checks, or failure recovery
instead.
