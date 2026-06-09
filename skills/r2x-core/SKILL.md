---
name: r2x-core
description: Build and maintain r2x-core translators across plugin lifecycle, rule mapping, datastore ingestion, units, and upgrades. Use when tasks mention r2x-core plugins/rules/datastore/unit-system/versioning, or when translating between model formats on top of infrasys.
license: MIT
---

# r2x-core

## Use when
- Implementing or refactoring an r2x-core `Plugin`.
- Registering plugins via `@expose_plugin` and `r2x_plugin` entry points.
- Defining or debugging `Rule` / `RuleFilter` mappings and rule execution.
- Configuring `DataStore` / `DataFile` / `ReaderConfig` / HDF5 layout.
- Working on per-unit behavior (`HasUnits`, `HasPerUnit`, `UnitSystem`).
- Building or validating version/upgrade flows.

## Avoid when
- Task is pure infrasys modeling with no r2x-core surface (use `infrasys`).
- Task is generic Python/tooling guidance unrelated to r2x-core.
- User asks for model-domain semantics only (no translator/framework changes).

## Quick start (pick by task center)
- Plugin lifecycle and registration: [PLUGINS.md](./PLUGINS.md)
- Rules and execution semantics: [RULES.md](./RULES.md)
- Data ingestion and HDF5 layout: [DATA_STORE.md](./DATA_STORE.md)
- Unit-system behavior: [UNITS.md](./UNITS.md)
- Versioning and upgrade chains: [VERSIONING_UPGRADES.md](./VERSIONING_UPGRADES.md)
- Cross-cutting API reference: [REFERENCE.md](./REFERENCE.md)
- Discovery protocol: [DISCOVERY.md](./DISCOVERY.md)
- Trigger examples: [EXAMPLES.md](./EXAMPLES.md)

## Validation helpers
- [tools/check_api_symbols.py](./tools/check_api_symbols.py)
- [tools/inspect_plugins.py](./tools/inspect_plugins.py)
- [tools/check_data_store.py](./tools/check_data_store.py)

## Workflow
1. **Scope the surface**: plugin, rules, store, units, or versioning.
2. **Inspect before edits**: confirm current behavior from source/tests/docs.
3. **Verify API reality**: when signatures are uncertain, check installed package/source before coding.
4. **Implement minimally**: prefer small, reversible changes and preserve public contracts.
5. **Validate touched paths**: run targeted tests/checks for modified behavior.
6. **Report clearly**: summarize behavior changes, evidence, and residual risks.

## Output
- Surface touched (plugin/rules/store/units/versioning)
- Key files/APIs changed
- Validation commands + outcomes
- Risks, assumptions, and follow-ups
