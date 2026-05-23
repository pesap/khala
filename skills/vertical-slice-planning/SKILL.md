---
name: vertical-slice-planning
description: Break an approved engineering plan into thin vertical-slice implementation issues with dependencies, acceptance criteria, and AFK/HITL execution tags. Use when users ask to split a plan into issues, create implementation slices, sequence work for agents, or turn a design into trackable delivery tasks.
---

## Use when
- Plan is complete and user wants issue creation.
- User asks to split work into executable slices.
- User needs AFK/HITL labels, dependency order, or issue-ready acceptance criteria.

## Avoid when
- The plan is still being debated; use the planning skill first.
- The user wants implementation now rather than issue planning.
- The target tracker/platform is unknown and issue creation is required; detect it first.

## Workflow
1. Identify the user-visible outcome and the smallest deployable checkpoints.
2. Prefer thin end-to-end slices over layer-based tasks.
3. Make each slice independently testable or demoable.
4. Mark each slice as AFK when an agent can complete it from repo context; mark HITL when product judgment, credentials, external access, or risky migration approval is needed.
5. Capture dependency edges explicitly and order slices so each issue can start from a known prior state.
6. Keep titles action-oriented and specific.

## Output
- Numbered slice list
- For each slice: title, type (AFK/HITL), blocked-by, acceptance criteria
- Issue creation order
