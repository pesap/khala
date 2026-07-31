# Decision/design planning guide

Use this guide to rescue the useful decision/design parts of GSD without
adopting its `.planning/` machinery.

## Posture

Be a thinking partner, not an interviewer.

- Follow the user's energy instead of walking a fixed checklist.
- Ask questions that sharpen the idea, not questions that merely fill a
  template.
- Challenge vague words: "simple", "fast", "good", "users", "workflow", "done".
- Make abstract claims concrete: ask for scenarios, examples, inputs, outputs,
  and failure cases.
- Stop questioning when the plan is clear enough to act on safely.

## Minimum clarity checklist

Before finalizing a plan, know these four things:

1. **What** are we building or deciding?
2. **Why** does it need to exist?
3. **Who** is it for or who is affected?
4. **Done**: what observable outcome proves it worked?

If one is unclear, ask one targeted question before finalizing.

## Ambiguity gate

Internally rate each dimension as `clear`, `partial`, or `unclear`:

| Dimension   | What to check                                                                |
| ----------- | ---------------------------------------------------------------------------- |
| Goal        | Outcome is specific and measurable.                                          |
| Boundary    | In-scope and out-of-scope are explicit.                                      |
| Constraints | Compatibility, performance, data, security, or operational limits are known. |
| Acceptance  | The verification path is pass/fail, not vibes.                               |

If any dimension is `unclear`, ask one more question. If it remains unclear,
mark it as an assumption or open question in the final plan.

## Perspective rotation

Pick the perspective that best exposes the next blind spot:

- **Researcher**: what exists now, what changed, what evidence is missing?
- **Simplifier**: what is the irreducible core; what can be cut?
- **Boundary keeper**: what explicitly will not be done?
- **Failure analyst**: what would make the result unsafe, wrong, or rejected?
- **Closer**: what final decision must be made before implementation?

Do not run every perspective mechanically. Use the smallest useful set.

## Gray-area selection

For bigger plans, identify 2-4 specific gray areas that would change
implementation. Let the user choose which to discuss.

Good gray areas are concrete:

- "Session lifetime" not "Auth"
- "Pagination vs infinite scroll" not "UX"
- "Error response shape" not "API"
- "Cache invalidation trigger" not "Performance"

When possible, annotate gray areas with existing code/docs evidence:

- prior decision that applies
- reusable component or pattern
- integration point
- conflicting source of truth

## Scope creep handling

When a new adjacent capability appears:

1. Name it as out of scope for the current plan.
2. Capture it as a deferred idea.
3. Redirect to the current goal.

Use wording like:

> That sounds like a separate capability. I’ll capture it as deferred, but keep
> this plan focused on X.

## Canonical references

When the user points at a doc, ADR, spec, issue, API, or code path:

1. Read it before asking follow-up questions when practical.
2. Include its repo-relative path in the final plan under `Canonical refs`.
3. Treat referenced docs as constraints unless they conflict with newer user
   decisions.

## Final plan shape

Include only sections that have useful content:

- Goal
- Why / user impact
- In scope
- Out of scope
- Canonical refs
- Existing code context
- Decisions made
- Deferred ideas
- Implementation approach
- Verification / acceptance checks
- Risks and open questions
