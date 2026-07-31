# Data Model QuickMap

Fast intent -> pattern lookup for LLM retrieval.

## If user asks...

### "simple internal typed object"

Use: `@dataclass(slots=True)`

### "validated request/response schema"

Use: Pydantic v2 `BaseModel` + `Annotated[..., Field(..., description=...)]`

Then check: are IDs, units, component references, solver names, datasets, and
model entities using semantic/domain types rather than bare `str` / `float`?

### "config/env settings"

Use: `pydantic-settings` (`BaseSettings`, `SettingsConfigDict`)

### "url/db/email/uuid/secret type"

Use built-ins first: `PostgresDsn`, `HttpUrl`, `EmailStr`, `UUID4`, `SecretStr`,
`PositiveFloat`

### "string category values"

Use: `Enum` (not free-form `str`)

### "boolean flag or optional field"

Pause and review the model shape. Prefer separate model variants or explicit
state models when a flag/`None` means different required fields or behavior.

### "union type"

Use: `A | B` (never `typing.Union`)

### "field exists?"

Use: `"field_name" in Model.model_fields`

### "custom serialization"

Use: `Annotated[..., PlainSerializer(...)]` alias (preferred)

### "external key naming"

Use: `Field(serialization_alias="...")`

### "skip fields in payload"

Use:

- field-level: `exclude=True`, `exclude_if=...`
- dump-level: `exclude_unset=True`, `exclude_none=True`

### "immutable/frozen update"

Use: `model_copy(update={...})` and `deep=True` when nested clone required

### "list/dict default"

Use: `Field(default_factory=list|dict|set)`

### "repeated constrained float"

Use built-in first; else alias:

- `UnitFloat = Annotated[float, Field(ge=0, le=1)]`

## Hard rules

- Pydantic v2 only.
- Reuse canonical package/System models before creating local copies.
- `description=` in `Field(...)` is the repo default, not a replacement for
  semantic types or units.
- No loose dicts for structured contracts.
- Inheritance for categorization only (not shared fields).
- Avoid `@computed_field` for core behavior.
