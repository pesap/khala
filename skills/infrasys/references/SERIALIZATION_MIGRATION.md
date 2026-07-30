# infrasys Serialization and Migration Reference

Use this document for persistence, deserialization debugging, and format
upgrades in infrasys.

## Scope in this skill

This reference covers:

- `System.to_json(...)` / `System.from_json(...)`
- `System.save(...)` / `System.load(...)`
- serialized type metadata (`__metadata__`)
- custom upgrade hooks and migration flow
- time-series metadata/store migration behavior

---

## Which persistence API to use

Use `to_json` / `from_json` when you want explicit files and directories.

```python
system.to_json("system.json")
loaded = System.from_json("system.json")
```

Use `save` / `load` when you want packaged archive workflow.

```python
system.save("output/my_system", zip=True)
loaded = System.load("output/my_system.zip")
```

Quick rule:

- local inspect/debug -> `to_json` / `from_json`
- transport/distribution artifact -> `save` / `load`

---

## On-disk layout

`to_json("path/system.json")` writes:

```
path/
├── system.json
└── system_time_series/
    ├── time_series_metadata.db
    ├── <uuid>.arrow              # Arrow backend (common)
    ├── time_series_storage.h5    # HDF5 backend
    └── ...
```

`time_series.directory` in JSON is stored as relative directory name.

---

## `__metadata__` contract

Serialized models carry type metadata:

```json
"__metadata__": {
  "module": "my_pkg.models",
  "type": "Generator",
  "serialized_type": "base"
}
```

Supported `serialized_type` values:

- `"base"` -> normal model instance
- `"composed_component"` -> UUID reference to another component
- `"quantity"` -> quantity with unit metadata

Deserialization depends on `module.type` importability in runtime environment.

---

## Composed component references

When component contains another component field, serialization stores reference
metadata instead of duplicating full nested object.

During load, infrasys resolves references after dependent types are
deserialized.

Failure symptom if broken:

- unresolved type import
- unresolved referenced UUID during build phase

---

## Custom System hooks (subclass path)

If you subclass `System`, these hooks are primary extension points:

- `serialize_system_attributes(self) -> dict[str, Any]`
- `deserialize_system_attributes(self, data: dict[str, Any]) -> None`
- `data_format_version` property
- `handle_data_format_upgrade(self, data, from_version, to_version) -> None`

Important constraints:

- keys returned by `serialize_system_attributes` must not collide with core
  system keys (`name`, `components`, `time_series`, etc.).
- upgrade hook must transform data in-place deterministically.

---

## Upgrade path (composition pattern)

If parent package composes `System` instead of subclassing, use
`upgrade_handler`:

```python
def my_upgrade_handler(data, from_version, to_version):
    # mutate serialized dict in place
    ...

loaded = System.from_json("old.json", upgrade_handler=my_upgrade_handler)
```

Use this for package-owned schema changes outside infrasys core models.

---

## Example: model field changed (rename/add/remove)

Case:

- old model field: `rating_mw`
- new model field: `max_active_power_mw`
- serialized old files still contain `rating_mw`

### Subclass approach (`handle_data_format_upgrade`)

```python
class GridSystem(System):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._data_format_version = "2.0.0"

    def handle_data_format_upgrade(self, data, from_version, to_version) -> None:
        if from_version == "1.0.0" and to_version == "2.0.0":
            for comp in data["components"]:
                md = comp.get("__metadata__", {})
                if md.get("type") == "Generator":
                    # rename field
                    if "rating_mw" in comp and "max_active_power_mw" not in comp:
                        comp["max_active_power_mw"] = comp.pop("rating_mw")
                    # add new required field default
                    comp.setdefault("dispatch_priority", 0)
                    # remove deprecated field if present
                    comp.pop("legacy_heat_rate", None)
```

### Composition approach (`upgrade_handler`)

```python
def upgrade_handler(data, from_version, to_version):
    if from_version == "1.0.0" and to_version == "2.0.0":
        for comp in data.get("components", []):
            md = comp.get("__metadata__", {})
            if md.get("type") == "Generator" and "rating_mw" in comp:
                comp["max_active_power_mw"] = comp.pop("rating_mw")

loaded = System.from_json("legacy.json", upgrade_handler=upgrade_handler)
```

Migration rules for field changes:

1. Rename old -> new key before model validation.
2. Add deterministic defaults for new required fields.
3. Drop deprecated keys safely (`pop(..., None)`).
4. Gate logic by `from_version` and component type.
5. Keep transform idempotent (safe if run twice).

---

## Built-in automatic migrations

In current infrasys flow, `from_json`/`from_dict` automatically applies:

1. **Legacy time-series metadata DB migration**
   - Migrates legacy `time_series_metadata` table to `time_series_associations`
     schema.
   - Converts old resolution format to ISO-8601 duration.
   - Renames legacy user attributes to features structure.

2. **Legacy component metadata flattening**
   - Migrates old nested `__metadata__.fields` format to flattened
     `__metadata__`.

You usually do not call these migrations manually.

---

## Storage behavior on deserialize/load

Default behavior:

- restores storage backend from serialized data (`arrow`, `hdf5`, `chronify`,
  etc.)

Override behavior:

- `from_json(..., time_series_storage_type=TimeSeriesStorageType.HDF5)` can
  convert loaded store to another persistent backend.
- `time_series_storage_type=MEMORY` is **not supported in deserialization path**
  and raises operation error.

Post-load conversion (safe pattern):

```python
loaded = System.from_json("system.json")
loaded.convert_storage(time_series_storage_type=TimeSeriesStorageType.HDF5)
```

---

## Validation checklist

After serialization/migration changes:

1. Serialize with `to_json`.
2. Deserialize with `from_json`.
3. Validate critical component retrieval and associations.
4. Validate time series retrieval (by key and/or filters).
5. Validate supplemental attribute links.
6. If archive path used, validate `save(..., zip=True)` + `load(...)`.

Minimal invariant check:

```python
system.to_json("tmp.json", overwrite=True)
loaded = System.from_json("tmp.json")
assert loaded.get_component(Generator, "gen1").name == "gen1"
```

---

## Common failure modes

- Missing importable module/type from `__metadata__`.
- Ambiguous or malformed time-series metadata/features.
- Invalid zip input for `System.load(...)` (not zip, multiple JSON files, none
  found).
- Invalid destination directory assumptions (`time_series_directory` must exist
  for certain flows).
- Empty component-list edge case in some versions (deserialize may fail with
  `IndexError`).

---

## Operational validation utilities

Validate JSON parseability/basic shape:

```bash
bash scripts/check_system_json.sh <path/to/system.json> --strict
```

Inspect metadata DB tables/counts/samples:

```bash
uvx --from python python scripts/inspect_time_series_db.py <path/to/system_time_series-or-db> --sample 3
```

Inspect installed source paths when behavior is unclear:

```bash
uvx --from python --with infrasys python - <<'PY'
import infrasys.system as s
import infrasys.serialization as ser
import infrasys.migrations.db_migrations as dbm
print(s.__file__)
print(ser.__file__)
print(dbm.__file__)
PY
```
