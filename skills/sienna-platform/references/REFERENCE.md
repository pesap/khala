# Sienna Platform Reference

Use this reference after loading `SKILL.md`. The Sienna Platform is a multi-package ecosystem under `Sienna-Platform`, so first route the task to the right package cluster.

## Evidence and discovery

Use `gh` for GitHub interactions.

```bash
# List package metadata for routing
gh repo list Sienna-Platform --limit 100 \
  --json name,description,primaryLanguage,isArchived,isPrivate,url,updatedAt

# Read a package README through the GitHub API
gh api repos/Sienna-Platform/PowerSystems.jl/readme \
  -H 'Accept: application/vnd.github.raw'

# Inspect package metadata
gh repo view Sienna-Platform/PowerSystems.jl \
  --json name,description,url,homepageUrl,primaryLanguage,repositoryTopics,latestRelease
```

Do not use `gh repo view --json readme`; `readme` is not a supported `gh repo view` field.

## Package clusters

### Core infrastructure and data models
- `InfrastructureSystems.jl` — utilities supporting infrastructure data models across Sienna.
- `PowerSystems.jl` — foundational power-system data model; used by simulations and dynamics packages.

### Optimization infrastructure and operations models
- `InfrastructureOptimizationModels.jl` — core abstractions such as `DecisionModel`, `EmulationModel`, and `OptimizationContainer`.
- `PowerOperationsModels.jl` — component optimization models for thermal, renewable, storage, HVDC, loads, and network formulations.
- `PowerSimulations.jl` — modeling and simulation of power-system operations, using `PowerSystems.jl` data.

### Simulation extensions
- `PowerSimulationsDynamics.jl` — dynamic power-system simulations.
- `HydroPowerSimulations.jl` — hydropower simulation extension.
- `StorageSystemsSimulations.jl` — storage-system simulation extension.
- `HybridSystemsSimulations.jl` — hybrid energy-system simulations.

### Power flow and network math
- `PowerFlows.jl` — power-flow solution methods.
- `PowerNetworkMatrices.jl` — matrix representations of power-system networks.
- `PowerFlowFileParser.jl` — parsing libraries for power-flow files.

### Investment and planning
- `PowerSystemsInvestments.jl` — investment, capacity-expansion, and transmission-expansion modeling.
- `PowerSystemsInvestmentsPortfolios.jl` — data models for investment portfolios.
- `PowerSystemsInvestmentsPortfoliosTestData` — test data for portfolio workflows.

### Analytics, visualization, data, schemas, and cases
- `PowerAnalytics.jl` — analysis routines for simulation results.
- `PowerGraphics.jl` — visualizations for `PowerSimulations.jl` results.
- `PowerSystemCaseBuilder.jl` — case building for power-system modeling.
- `PowerSystemsTestData` — shared test data.
- `SiennaSchemas`, `SiennaGridDB`, `PowerOpenAPIModels`, `power-openapi-models` — schemas, database/API models, and interop surfaces.

### Website, templates, and interfaces
- `Sienna` — public website and technical documentation aggregation.
- `SiennaTemplate.jl` — template repository for Sienna applications.
- `SiennaPRASInterface.jl` — PRAS interface maintained by Sienna/Ops.

## Routing guidance

- Data model, device definitions, time series, parsing: start with `PowerSystems.jl` and `InfrastructureSystems.jl`.
- Optimization model internals, containers, formulations, outputs: start with `InfrastructureOptimizationModels.jl` and `PowerOperationsModels.jl`.
- Production cost, unit commitment, market simulation, multi-period operations: start with `PowerSimulations.jl`.
- Dynamics: start with `PowerSimulationsDynamics.jl`.
- Hydro/storage/hybrid extensions: start with the matching extension package and check its dependency on `PowerSimulations.jl`.
- Power flow/network matrices/parsers: start with `PowerFlows.jl`, `PowerNetworkMatrices.jl`, or `PowerFlowFileParser.jl`.
- Investment planning: start with `PowerSystemsInvestments.jl` and portfolio packages.
- Plots/results analysis: start with `PowerAnalytics.jl` or `PowerGraphics.jl`.
- Public website/docs navigation: start with `Sienna`.

## Validation patterns

Prefer the target repo's documented workflow. Common Julia checks include:

```julia
using Pkg
Pkg.test()
```

For docs tasks, inspect the package documentation workflow and `docs/` or `Documenter.jl` setup before proposing commands.

For multi-package changes, validate the lowest-level changed package first, then any dependent package whose public API is affected.

## Boundaries and cautions

- Do not assume private repositories are available or safe to summarize; mention them only when user scopes them and access is explicit.
- Do not treat one package as canonical for the whole platform without evidence.
- Avoid broad rewrites across packages; split cross-package changes into reviewable slices.
- Preserve public APIs and serialized schemas unless a breaking change is explicitly approved.
- Prefer package-specific docs/tests over generic Julia or JuMP advice.
