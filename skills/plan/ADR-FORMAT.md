# ADR Format

ADRs live in `docs/adr/` with sequential filenames:

- `0001-slug.md`
- `0002-slug.md`

Create `docs/adr/` lazily (only when first ADR is needed).

## Minimal template

```md
# {Short title of the decision}

{1-3 sentences: context, decision, and why.}
```

Keep ADRs short by default.

## Optional sections (only when useful)

- Status frontmatter (`proposed|accepted|deprecated|superseded by ADR-NNNN`)
- Considered options
- Consequences

## Numbering

- Scan `docs/adr/` for highest number and increment by one.

## Offer an ADR only when all are true

1. Hard to reverse
2. Surprising without context
3. Result of a real trade-off

## Good ADR candidates

- Architectural shape and boundaries
- Cross-context integration patterns
- Lock-in technology choices
- Explicit ownership/no-go boundary decisions
- Deliberate deviations from obvious defaults
- Constraints not visible in code
