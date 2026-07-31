# infrasys Time Series Integration Reference

Use this document when system-level infrasys task needs time series
attach/query/storage behavior.

## Scope in this skill

This reference covers:

- attach, list, retrieve, remove time series
- ownership (`Component` vs `SupplementalAttribute`)
- `TimeSeriesKey` semantics and key-first retrieval
- feature labels (`add_time_series(..., **features)`)
- storage backend selection and conversion
- persistence checks (`to_json`/`from_json`, `save`/`load`)

## Core APIs to know

- `system.add_time_series(...) -> TimeSeriesKey`
- `system.get_time_series(...)`
- `system.get_time_series_by_key(...)`
- `system.list_time_series_keys(...)`
- `system.list_time_series_metadata(...)`
- `system.has_time_series(...)`
- `system.remove_time_series(...)`
- `system.copy_time_series(...)` _(currently not implemented in manager path)_
- `system.open_time_series_store(...)` (batch transactions for backend contexts)
- `system.convert_storage(...)`

---

## What is `TimeSeriesKey`

`TimeSeriesKey` is compact lookup handle returned by `add_time_series` and
`list_time_series_keys`.

Base fields:

- `name: str`
- `time_series_type: Type[TimeSeriesData]`
- `features: dict[str, Any]`

Type-specific key variants add shape/timing fields:

- `SingleTimeSeriesKey`: adds `length`, `initial_timestamp`, `resolution`
- `NonSequentialTimeSeriesKey`: adds `length`
- `DeterministicTimeSeriesKey`: adds `initial_timestamp`, `resolution`,
  `interval`, `horizon`, `window_count`

Why key matters:

- stable handle for later retrieval
- avoids ambiguous `name + features` lookups
- no need to re-specify all filter args manually

---

## Recommended retrieval path

Preferred flow:

1. Write once: `key = system.add_time_series(...)`
2. Persist/propagate `key` with owning object context
3. Read via `system.get_time_series_by_key(owner, key)`

Use `system.get_time_series(...)` when:

- key not available (discovery or migration code)
- filtering by partial attributes intentionally

If using `get_time_series(...)`, pass enough fields (`name`, `time_series_type`,
features) to avoid multi-match errors.

---

## Labels/features in `add_time_series`

`add_time_series` supports arbitrary JSON-serializable feature tags via
`**features`.

### One label

```python
key = system.add_time_series(ts, gen, scenario="baseline")
```

### Multiple labels (multiple feature keys)

```python
key = system.add_time_series(
    ts,
    gen,
    scenario="baseline",
    weather_year="2035",
    source="nrel",
)
```

### Multiple labels (single feature carrying a list)

```python
key = system.add_time_series(
    ts,
    gen,
    labels=["baseline", "nrel", "day_ahead"],
)
```

Notes:

- Feature values should be JSON-serializable.
- Key-based retrieval is safest when using complex feature payloads (for example
  list-valued labels).

---

## Ownership model

Time series can attach to:

- `Component` (common case, e.g. generator `active_power`)
- `SupplementalAttribute` (cross-cutting metadata objects)

Always be explicit about owner + features when querying.

---

## Minimal key-first pattern

```python
from infrasys import System

system = System(name="grid")
system.add_component(gen)

key = system.add_time_series(ts, gen, scenario="baseline")

# Recommended retrieval
same_ts = system.get_time_series_by_key(gen, key)

# Discovery retrieval (when key not available)
same_ts2 = system.get_time_series(gen, name="active_power", scenario="baseline")

keys = list(system.list_time_series_keys(gen))
metadata = list(system.list_time_series_metadata(gen))
```

---

## Storage backend types

`TimeSeriesStorageType` enum includes:

- `ARROW` (default general-purpose backend)
- `HDF5` (single-file backend; useful for large array counts / shared FS
  pressure)
- `MEMORY` (ephemeral, fastest for prototyping)
- `CHRONIFY` (optional dependency; SQL-backed)
- `PARQUET` (enum value exists; not wired as active manager backend in current
  registry)

System constructor knobs:

- `time_series_storage_type=...`
- `time_series_directory=Path(...)`
- `time_series_read_only=True|False`
- `chronify_engine_name="duckdb"` (chronify path)

---

## How to change storage type

### At system creation

```python
from infrasys import System
from infrasys.time_series_models import TimeSeriesStorageType

system = System(time_series_storage_type=TimeSeriesStorageType.HDF5)
```

### Existing system (in-place conversion)

```python
system.convert_storage(time_series_storage_type=TimeSeriesStorageType.ARROW)
system.convert_storage(time_series_storage_type=TimeSeriesStorageType.HDF5)
system.convert_storage(time_series_storage_type=TimeSeriesStorageType.MEMORY)
```

Optional when you need persistent destination directory during conversion:

```python
system.convert_storage(
    time_series_storage_type=TimeSeriesStorageType.ARROW,
    time_series_directory="/path/to/ts",
    permanent=True,
)
```

Important:

- `System.from_json(..., time_series_storage_type=...)` can request a different
  persistent backend during load.
- `time_series_storage_type=MEMORY` is not supported in deserialization path.
- Most predictable workflow: load first, then call `system.convert_storage(...)`
  explicitly.

---

## Batch operations and contexts

For many read/write operations, use store context:

```python
with system.open_time_series_store() as context:
    system.add_time_series(ts1, gen1, context=context, scenario="baseline")
    system.add_time_series(ts2, gen2, context=context, scenario="baseline")
```

Why:

- fewer backend open/close cycles
- transactional rollback on exception for grouped writes

---

## Persistence checks

When touching time series wiring:

1. Add and retrieve by key.
2. Retrieve by `name + features`.
3. Round-trip serialize (`to_json`/`from_json`).
4. If archive workflows matter, verify `save`/`load`.

```python
system.to_json("system.json")
loaded = System.from_json("system.json")
loaded_ts = loaded.get_time_series(loaded_gen, name="active_power", scenario="baseline")
```

If metadata behavior unclear, inspect SQLite metadata directly:

```bash
uvx --from python python scripts/inspect_time_series_db.py <path/to/system_time_series-or-db> --sample 3
```

---

## Common mistakes to avoid

- Not storing returned `TimeSeriesKey`; then relying on ambiguous feature-only
  lookups.
- Omitting distinguishing features when same `name` is reused.
- Treating `get_components(...)` as time series retrieval API.
- Forgetting backend constraints when moving from local dev to HPC/shared
  storage.
- Assuming storage-type override during `from_json`; use `convert_storage(...)`
  after load.

## Related integrated references

- `COST_CURVES.md`: production-cost and fuel-curve modeling that can consume
  time series signals.
- `SERIALIZATION_MIGRATION.md`: format upgrades and compatibility behavior.
- `SUPPLEMENTAL_ATTRIBUTES.md`: ownership patterns for non-component
  attachments.
