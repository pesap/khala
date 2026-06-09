---
name: triage-issue
description: Triage a bug by investigating root cause in the codebase, then create a GitHub issue with a behavior-focused TDD fix plan. Use when users report a bug or ask to investigate and file a fix plan.
license: MIT
---

## Source
- Adapted from: https://github.com/mattpocock/skills/tree/main/skills/engineering/triage

## Use when
- User reports a defect/regression and wants a ticket.
- User asks to investigate root cause before coding.
- User asks for a fix plan with test-first steps.

## Avoid when
- User already provided a final issue and does not want investigation.
- Task is feature planning, not bug triage.

## Workflow
1. Capture problem statement (ask one minimal clarifying question only if needed).
2. Investigate code paths, related tests, and recent changes.
3. Determine root cause and minimal durable fix direction.
4. Build TDD plan as RED/GREEN vertical slices.
5. Create GitHub issue with problem, root cause analysis, TDD plan, and acceptance criteria.

## Output
- Root cause summary
- TDD fix plan (ordered RED/GREEN cycles)
- Created issue URL/number (or reason issue creation failed)
- Risks and unknowns requiring follow-up
