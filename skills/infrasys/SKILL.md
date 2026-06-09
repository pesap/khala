---
name: infrasys
description: >
  Build, inspect, mutate, serialize, and evolve infrasys System/Component
  models with typed APIs and safe persistence. Use when users work with
  infrasys systems, components, time series, supplemental attributes,
  cost curves, or serialization/migration, even if they only say "inspect
  the system", "add a component", "fix deserialization", "attach time
  series", "model costs", "migrate schema", "grid model", "power system
  model", "component graph", or "system of components". infrasys is the
  foundational modeling layer; r2x-core is an application built on top of it.
license: MIT
---

# infrasys

## Use when

- Building, extending, or refactoring `System` + `Component` models.
- Inspecting an existing system: listing components, querying associations, navigating the graph.
- Attaching, retrieving, converting, or debugging time series on components or supplemental attributes.
- Defining supplemental attributes for cross-cutting metadata with many-to-many ownership.
- Modeling production costs or fuel curves with `CostCurve`, `FuelCurve`, and `ValueCurve` types.
- Serializing/deserializing systems (`to_json`/`from_json`, `save`/`load`).
- Writing or debugging schema migration hooks (`data_format_version`, `handle_data_format_upgrade`).
- Validating round-trip persistence after model changes.

## Avoid when

- Task has no infrasys `System`/`Component` involvement.
- Primary concern is r2x-core plugin lifecycle, rule mapping, or datastore design (use the `r2x-core` skill).
- General architecture advice unrelated to typed component graphs.

## Quick reference lookup

Load the right reference doc based on task center-of-gravity:

| Task area | Reference |
|---|---|
| System navigation, inspection, mutation, API contracts | [references/REFERENCE.md](./references/REFERENCE.md) |
| Time series attach/query/storage/backend | [references/TIME_SERIES.md](./references/TIME_SERIES.md) |
| Production cost and fuel curve modeling | [references/COST_CURVES.md](./references/COST_CURVES.md) |
| Serialization, deserialization, format upgrades | [references/SERIALIZATION_MIGRATION.md](./references/SERIALIZATION_MIGRATION.md) |
| Supplemental attributes and many-to-many metadata | [references/SUPPLEMENTAL_ATTRIBUTES.md](./references/SUPPLEMENTAL_ATTRIBUTES.md) |
| API symbol drift checking, JSON validation, DB inspect | [scripts/](#scripts) |
| Discovering and validating external sources | [references/DISCOVERY.md](./references/DISCOVERY.md) |

Read `SKILL.md` first. Load a reference doc only when the task needs its detail.

## Workflow

1. **Inspect first, change second.**
   - Inventory the current system: `system.info()`, `system.show_components(...)`, `get_component_types()`, `get_components(...)`, `list_components_by_name(...)`.
   - For time series: `list_time_series_keys(...)`, `list_time_series_metadata(...)`.
   - Follow [references/DISCOVERY.md](./references/DISCOVERY.md) for source-of-truth verification.

2. **Define boundaries and associations.**
   - Keep domain state in typed `Component`/`System` models.
   - Use supplemental attributes for cross-cutting metadata (see [references/SUPPLEMENTAL_ATTRIBUTES.md](./references/SUPPLEMENTAL_ATTRIBUTES.md)).
   - If composed component references are reassigned after attach, call `rebuild_component_associations()`.

3. **Apply minimal model changes.**
   - Add or adjust components/associations with explicit naming.
   - Avoid dict blobs when a typed component or attribute is appropriate.

4. **Verify persistence.**
   - Round-trip `to_json`/`from_json` on touched paths.
   - Validate packaged workflows with `save`/`load` when archive distribution matters.
   - Use [scripts/check_system_json.sh](./scripts/check_system_json.sh) to catch malformed JSON.
   - Use [scripts/inspect_time_series_db.py](./scripts/inspect_time_series_db.py) for metadata DB inspection.
   - For migration-heavy paths, consult [references/SERIALIZATION_MIGRATION.md](./references/SERIALIZATION_MIGRATION.md).

5. **Respect extension hooks.**
   - Custom `System` subclasses: `serialize_system_attributes`, `deserialize_system_attributes`, `data_format_version`, `handle_data_format_upgrade`.
   - Cost curve modeling: [references/COST_CURVES.md](./references/COST_CURVES.md).
   - Time series backend decisions: [references/TIME_SERIES.md](./references/TIME_SERIES.md).

## Key API cheat sheet

```python
from infrasys import System, Component

system = System(name="my_system")

# Add / get components
system.add_component(gen)
gen = system.get_component(Generator, "gen1")          # exactly one match
gens = list(system.get_components(Generator))           # iterable stream
named = system.list_components_by_name(Generator, "g1") # list of matches
system.show_components(Generator, show_uuid=True)       # display table

# Time series
key = system.add_time_series(ts, gen, scenario="base")
ts = system.get_time_series_by_key(gen, key)            # preferred
ts = system.get_time_series(gen, name="active_power")   # discovery

# Persistence
system.to_json("system.json")
loaded = System.from_json("system.json")
```

## Scripts

| Script | Purpose |
|---|---|
| [scripts/check_api_symbols.py](./scripts/check_api_symbols.py) | Detect API drift in installed `infrasys` |
| [scripts/check_system_json.sh](./scripts/check_system_json.sh) | Validate JSON parseability and minimal structure |
| [scripts/inspect_time_series_db.py](./scripts/inspect_time_series_db.py) | Inspect time series metadata DB tables/counts/samples |

## Failure playbook

| Symptom | Fix |
|---|---|
| `get_component` fails (missing/ambiguous) | Use `list_components_by_name` or `show_components(..., show_uuid=True)` |
| Associations wrong after mutating composed refs | Run `rebuild_component_associations()` |
| Time series retrieval returns wrong record | Add distinguishing feature tags in `add_time_series` and `get_time_series` |
| Deserialization / type resolution fails | Confirm module/type importability; see [references/SERIALIZATION_MIGRATION.md](./references/SERIALIZATION_MIGRATION.md) |
| JSON appears malformed | Run `bash scripts/check_system_json.sh <path> [--strict]` |
| Metadata DB looks wrong | Run `python scripts/inspect_time_series_db.py <path> [--sample N]` |

## Anti-patterns to avoid

- **Dict blobs instead of typed components** — always define a `Component` subclass.
- **Calling `list_components()`** — does not exist; use `get_components(...)` or `list_components_by_name(...)`.
- **Ignoring returned `TimeSeriesKey`** — store it; avoids ambiguous lookups later.
- **Overriding storage type during `from_json`** — use `convert_storage(...)` after load instead.
- **Putting core invariants in supplemental attributes** — those belong on the `Component`.
- **Skipping round-trip check after model changes** — always `to_json` → `from_json` → assert.

## Output

- System inspection findings (what exists, specific API calls used)
- Proposed model changes and rationale
- Serialization/deserialization verification results
- Association integrity notes
- Which reference docs were consulted and why
