# infrasys Supplemental Attributes Reference

Use this document when metadata should be modeled outside component schema but
still be attached/queryable in `System`.

## Why use supplemental attributes

Use `SupplementalAttribute` for cross-cutting metadata with many-to-many
ownership.

Good fit:

- Same metadata reused across multiple components.
- Metadata lifecycle independent from component class lifecycle.
- Need to attach/query side metadata without bloating core component fields.
- Need attribute-level ownership for time series.

Do **not** use for core component invariants that belong in typed component
fields.

---

## What `SupplementalAttribute` is

`SupplementalAttribute` is base infrasys model with UUID identity and optional
user fields.

Base class fields:

- `uuid` (auto-generated)

Your subclass defines domain fields (required/optional) via Pydantic
annotations.

Optional lifecycle hook:

- `check_supplemental_attribute_addition(self) -> None`
  - called before first system attachment
  - use for custom guardrails

---

## Core APIs

Attach/query/remove:

- `system.add_supplemental_attribute(component, attribute)`
- `system.get_supplemental_attributes_with_component(component, supplemental_attribute_type=None, filter_func=None)`
- `system.get_components_with_supplemental_attribute(attribute)`
- `system.has_supplemental_attribute(component, supplemental_attribute_type=None)`
- `system.has_supplemental_attribute_association(component, attribute)`
- `system.remove_supplemental_attribute(attribute)`
- `system.remove_supplemental_attribute_from_component(component, attribute)`

Inventory:

- `system.get_supplemental_attributes(*types, filter_func=None) -> Generator[...]`
- `system.get_supplemental_attribute_by_uuid(uuid) -> SupplementalAttribute`
- `system.get_supplemental_attribute_counts_by_type() -> list[dict[str, Any]]`
- `system.get_num_supplemental_attributes() -> int`
- `system.get_num_components_with_supplemental_attributes() -> int`

Transactional metadata context:

- `system.open_metadata_store()`

---

## How to check existence (and exact return types)

Component-level checks:

- `system.has_supplemental_attribute(component, supplemental_attribute_type=None) -> bool`
  - `True` if component has at least one supplemental attribute.
  - If type passed, `True` only when component has attribute of that type.
- `system.has_supplemental_attribute_association(component, attribute) -> bool`
  - `True` only for exact `(component, attribute-instance)` association.

System-level checks:

- `system.get_num_supplemental_attributes() -> int`
  - number of distinct supplemental attribute instances attached in system.
- `system.get_num_components_with_supplemental_attributes() -> int`
  - number of components that have >=1 supplemental attribute.
- `system.get_supplemental_attribute_counts_by_type() -> list[dict[str, Any]]`
  - rows like `{"type": "GeographicInfo", "count": 12}`.

Recommended "system has any supplemental attributes" check:

```python
has_any = system.get_num_supplemental_attributes() > 0
```

---

## Mandatory fields and class design

Mandatory at base level:

- none besides auto `uuid`

Mandatory at subclass level:

- whatever your domain model marks required

Pattern:

```python
from typing import Annotated, Any
from pydantic import Field
from infrasys import SupplementalAttribute

class GeographicInfo(SupplementalAttribute):
    region: Annotated[str, Field(min_length=1)]
    geojson: Annotated[dict[str, Any], Field(description="GeoJSON payload")]
```

Optional validation hook:

```python
class FuelContract(SupplementalAttribute):
    supplier: str
    contract_id: str

    def check_supplemental_attribute_addition(self) -> None:
        if not self.contract_id.startswith("FC-"):
            raise ValueError("contract_id must start with FC-")
```

---

## Association semantics (important)

- One attribute can attach to many components.
- One component can attach many attributes.
- Re-attaching same `(component, attribute)` pair raises duplicate-association
  error.
- Reusing same attribute instance across components is expected (not
  duplication).

Example:

```python
geo = GeographicInfo(region="west", geojson={"type": "FeatureCollection", "features": []})

system.add_supplemental_attribute(bus1, geo)
system.add_supplemental_attribute(gen1, geo)
```

---

## Recommended usage path

1. Define typed attribute class with minimal fields.
2. Create attribute instance once when logically shared.
3. Attach to all owning components.
4. Validate both query directions:
   - component -> attributes
   - attribute -> components
5. For bulk updates, wrap in `open_metadata_store()` transaction.

```python
attrs = system.get_supplemental_attributes_with_component(gen1)
owners = system.get_components_with_supplemental_attribute(geo)
```

---

## Query behavior and filters

`get_supplemental_attributes_with_component` supports:

- `supplemental_attribute_type=MyAttribute` for type filtering
- `filter_func=lambda attr: ...` for predicate filtering

`get_supplemental_attributes(...)` returns generator. Materialize with
`list(...)` when needed.

Note:

- Passing an abstract attribute type (type with subclasses) is not supported in
  this API path.

---

## Remove behavior

### `system.remove_supplemental_attribute(attribute)`

- removes all associations for that attribute
- removes attribute from system cache
- if attribute owns time series, system removes those time series too

### `system.remove_supplemental_attribute_from_component(component, attribute)`

- removes only that association
- if attribute has no remaining component associations, attribute is removed
  from system

This prevents orphaned supplemental attributes.

---

## Time series on supplemental attributes

Supplemental attributes can be time series owners (same APIs as components).

```python
key = system.add_time_series(weather_ts, geo, scenario="baseline")
ts = system.get_time_series_by_key(geo, key)
meta = list(system.list_time_series_metadata(geo))
```

Use this when series belongs to shared metadata object (for example weather
station / market signal) instead of one component.

---

## Transactional metadata updates

Use metadata context for grouped attach/remove operations with rollback safety.

```python
with system.open_metadata_store():
    system.add_supplemental_attribute(gen1, geo)
    system.add_supplemental_attribute(gen2, geo)
```

If exception escapes context:

- SQLite metadata changes roll back
- in-memory supplemental caches roll back

Nested metadata contexts are not allowed.

---

## Serialization and persistence checks

When changing supplemental-attribute logic:

1. Attach attributes to representative components.
2. Validate both-direction lookups.
3. Serialize with `to_json` and reload with `from_json`.
4. Re-run lookups after reload.
5. If attribute-owned time series exist, verify those too.

```python
system.to_json("system.json")
loaded = System.from_json("system.json")
```

---

## Common mistakes

- Putting core component invariants into supplemental attributes.
- Duplicating logically-shared attribute instances instead of reusing one.
- Validating only one query direction.
- Forgetting that removing association can remove attribute if last owner.
- Ignoring rollback/transaction behavior in bulk metadata updates.
