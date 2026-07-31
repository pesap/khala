# infrasys System & Component Reference

Detailed API contracts, navigation commands, and data modeling patterns for
infrasys `System` and `Component` graphs.

For routing to other references (time series, cost curves, serialization,
supplemental attributes), see [SKILL.md](../SKILL.md).

## Mental Model

- Keep system state typed and explicit, avoid anonymous dict payloads.
- A domain class like `Generator` is a data model class that inherits from
  `infrasys.Component`.
- `System` stores those typed components, not loose dict records.

## Component Data Model Pattern

```python
from pydantic import Field
from infrasys import Component

class Generator(Component):
    # Inherits UUID/name/label behavior from Component
    active_power: float = Field(ge=0)
    rating: float = Field(gt=0)
```

## System Navigation and Inspection Commands

```python
from infrasys import System

system = System(name="my_system")

# get_components returns an iterable/generator-style stream of matches
generators_iter = system.get_components(Generator)
generators = list(generators_iter)  # materialize if needed

# Narrow listing by exact name
named_generators = system.list_components_by_name(Generator, "gen1")

# get_component returns exactly one component match by type+name
one_gen = system.get_component(Generator, "gen1")

# Render a quick table view for inspection
system.show_components(Generator, show_uuid=True, show_time_series=True)

# Typical consumption pattern for get_components
for gen in system.get_components(Generator):
    print(gen.name)
```

## API Contracts (high-signal behavior)

- `get_components(*types, filter_func=None)` returns an iterable stream of
  matching components.
- `get_component(component_type, name)` returns one component when the type+name
  match is unique.
- `list_components_by_name(component_type, name)` returns a list of matches and
  is useful for ambiguity checks.
- `show_components(component_type, ...)` renders an inspection table and is a
  display helper, not a data-return API.

Behavior notes:

- `get_components(...)` is never a single component return.
- There is no `list_components(...)` API in `System`; use `get_components(...)`
  (optionally wrapped in `list(...)`) or `list_components_by_name(...)`.
- `get_component(...)` raises if the component is missing, or if the name is
  ambiguous for that type.

Time series discovery helpers (on a component or supplemental attribute):

```python
# Lightweight keys/metadata inspection
for key in system.list_time_series_keys(gen):
    print(key)

for meta in system.list_time_series_metadata(gen):
    print(meta.name, meta.features)

# Existence check before retrieval
if system.has_time_series(gen, name="active_power"):
    ts = system.get_time_series(gen, name="active_power")
```

## Core Commands You’ll Use Most

```python
# Mutate component graph
system.add_component(gen)

# Attach time series
key = system.add_time_series(ts, gen)

# Read time series by lookup or by key
ts = system.get_time_series(gen, name="active_power")
ts_by_key = system.get_time_series_by_key(gen, key)

# Remove time series
system.remove_time_series(gen, time_series_type=SingleTimeSeries, name="active_power")
```

For deeper time series design and API coverage, use
[TIME_SERIES.md](./TIME_SERIES.md). For production-cost and fuel-curve
representations, use [COST_CURVES.md](./COST_CURVES.md).

For failure diagnosis steps, see the failure playbook in
[SKILL.md](../SKILL.md). For serialization/deserialization patterns and
migration, see [SERIALIZATION_MIGRATION.md](./SERIALIZATION_MIGRATION.md).

## Data Modeling Best Practices

- Inherit from `Component` for domain entities, never store loose dicts.
- Use Pydantic `Field(...)` with constraints (`ge`, `gt`, `min_length`, etc.).
- Prefer composition (component references) over deep inheritance hierarchies.
- Use `SupplementalAttribute` only for cross-cutting metadata; core invariants
  belong on the component.
- Always name components explicitly at creation; avoid relying on auto-generated
  names.
