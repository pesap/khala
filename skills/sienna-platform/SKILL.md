---
name: sienna-platform
description: Build, debug, document, and route work across the Sienna Platform multi-package Julia ecosystem for power-system data models, simulations, optimization models, power flow, investments, analytics, schemas, and case data. Use when users mention Sienna Platform, Sienna packages, PowerSystems.jl, PowerSimulations.jl, InfrastructureSystems.jl, InfrastructureOptimizationModels.jl, PowerOperationsModels.jl, or related Sienna-Platform GitHub org workflows.
---

# Sienna Platform

## Use when
- Working on Sienna Platform packages or the `Sienna-Platform` GitHub org.
- Debugging or extending Julia packages such as `PowerSystems.jl`, `PowerSimulations.jl`, `InfrastructureSystems.jl`, `InfrastructureOptimizationModels.jl`, or `PowerOperationsModels.jl`.
- Routing an issue across Sienna data models, optimization infrastructure, simulations, power flow, investment planning, analytics, schemas, or case-building packages.
- Updating Sienna package docs, tests, examples, or release-facing guidance.

## Avoid when
- The task is generic Julia, JuMP, optimization, or power-systems work with no Sienna package context.
- The task is only GitHub issue/PR/CI handling with no Sienna domain analysis (use `github`).
- The task targets private Sienna repos unless the user explicitly scopes them and access is available.

## Quick reference routing
Start with [references/REFERENCE.md](./references/REFERENCE.md), then inspect the package-specific README/docs for the target repo.

Use the reference for:
- package cluster map,
- repo discovery commands using `gh`,
- package selection guidance,
- common validation patterns,
- trigger boundaries and private-repo cautions.

## Workflow
1. Identify the Sienna package cluster and target repo before proposing changes.
2. Use `gh` for GitHub org/repo/issue/PR evidence; do not rely on manual GitHub browsing.
3. Read the target package README/docs and nearby tests before editing.
4. Keep changes package-local unless the dependency boundary requires coordinated edits.
5. Validate with the target package's existing Julia test/docs workflow where practical.
6. Report package(s) touched, cross-package assumptions, validation evidence, and residual risks.

## Output
- Target package/cluster and why it was selected
- Relevant docs/source/tests inspected
- Proposed or implemented changes by repo/package
- Validation commands and outcomes
- Cross-package compatibility risks
- Private/public repo assumptions
