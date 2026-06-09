---
name: dependency-untangler
description: Reduce unnecessary coupling by mapping and trimming dependency edges (including cycles) with behavior-preserving, low-risk edits. Use this skill when users ask to untangle imports/modules, break circular dependencies, improve layering, or simplify architecture without changing behavior.
license: MIT
---

## Use when
- User asks to reduce coupling, break dependency cycles, or clean module boundaries.
- Refactor scope shows import tangles, bidirectional dependencies, or unstable layering.
- Build/test graph or ownership boundaries are degraded by transitive dependencies.

## Avoid when
- Task is feature delivery where dependency cleanup is incidental and unvalidated.
- Architectural rewrites are requested without migration or rollback plan.
- Dynamic/plugin loading paths are unclear and cannot be safely validated.

## Instructions
1. Establish dependency baseline first.
   - Capture graph evidence (imports, module boundaries, cycles, hotspots).
   - Mark each edge as `required`, `optional`, or `accidental` with rationale.
2. Prioritize low-risk untangling moves.
   - Remove unused edges.
   - Invert direction via interface/adapter extraction when needed.
   - Isolate cross-layer utilities into stable shared boundaries only when justified.
3. Preserve behavior and public contracts.
   - No semantic changes unless explicitly approved.
   - Keep API/CLI/schema surfaces stable.
4. Apply edits incrementally.
   - Prefer small sequential changes over broad rewrites.
   - Validate after each batch of dependency edits.
5. Record residual coupling.
   - Keep medium/low-confidence candidates as follow-ups, not silent edits.

## Output
- Dependency findings (cycles, high-fanout nodes, accidental edges)
- Changes applied (edge removed/inverted/moved) with rationale
- Validation commands + results
- Deferred untangling candidates with blockers
- Risks and rollback notes