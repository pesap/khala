---
name: data-model
description:
  Design robust data contracts with dataclasses, Pydantic v2, pydantic-settings,
  and infrasys component patterns. Use when users ask about model shape,
  validation, serialization, typed config, schema evolution, or cleaning up
  loose dict/schema/model code into explicit typed contracts, even if they do
  not name Pydantic or dataclasses directly.
license: MIT
---

# Data Model

## Use when

- Designing/refactoring typed domain models.
- Choosing between `@dataclass`, Pydantic, settings, or infrasys component
  models.
- Defining field constraints, validators, serializers, aliases, or payload
  filtering.
- Creating generic typed response/container models.
- Updating schemas safely with backward compatibility in mind.
- Cleaning up loose dict/schema/model code into explicit validated contracts.
- Making config typed, fixing serialization shape, or tightening a weak data
  boundary.

## Avoid when

- Task is not about data contracts.
- User wants one-off scripting with no reusable model boundary.
- Domain requirements are still undefined.

## Quick router

1. Existing canonical package/System model -> reuse or extend that model; do not
   create a parallel local contract.
2. Simple trusted internal data -> `@dataclass`.
3. External validated/serialized data -> Pydantic v2 `BaseModel`/`RootModel`.
4. App config/env -> `pydantic-settings` (`BaseSettings`).
5. infrasys system entities -> `Component` / `SupplementalAttribute`.

## Guidance levels

- **Repo convention / default**: follow these unless local code reality or the
  user explicitly wants a different contract.
- **General modeling guidance**: use judgment where multiple good patterns
  exist.

## Non-negotiable rules

### A) Core modeling

1. Prefer typed models (`@dataclass` or Pydantic) over loose dicts.
2. Reuse the canonical model owner first. If an infrasys `System`, domain
   package, or upstream schema already owns the concept, do not create a
   duplicate local model in a consumer/runner package.
3. Use **Pydantic v2 only**.
4. Use `Annotated[...]` for modeled fields.
5. Put full type hint inside `Annotated`.
6. Use `Field(...)` for constrained fields.
7. In this repo, include `description=` in `Field(...)` unless there is a strong
   local reason not to.
8. `Field(description=...)` is not a substitute for domain typing. Important
   identifiers, units, component references, solver names, dataset names, and
   model entities need the strongest available semantic type or relationship.
9. Never use `typing.Union[...]`; use `A | B`.

### B) Type quality

10. Prefer built-in Pydantic semantic/constrained types before custom aliases
    (`PostgresDsn`, `PositiveFloat`, `EmailStr`, etc.).
11. For physical quantities, use the project's unit-aware model pattern when one
    exists. A raw `float` plus prose units is a fallback, not the preferred
    contract.
12. For finite domains, prefer `Enum` over free-form strings.
13. Treat new `bool` fields and optional fields as design-review triggers. They
    often mean the model is mixing states or should be split into separate
    models/variants.
14. If field drifts to `str | None` blob, extract nested model.
15. If an ID refers to a component/run/dataset, prefer a canonical component,
    value object, enum, or semantic alias over bare `str`.
16. For repeated float constraints, create typed alias only if built-ins do not
    fit.
17. For mutable defaults (`list`, `dict`, `set`), use
    `Field(default_factory=...)`.

### C) Validation/behavior

18. Use `field_validator` / `model_validator` (v2).
19. Use `model_dump` / `model_validate` (v2).
20. Check field existence with `Model.model_fields`.
21. Inside typed model boundaries, access required fields directly. Use
    `getattr(..., None)` or `dict.get(...)` only at dynamic/untyped boundaries.
22. Avoid `@computed_field` for core behavior; use explicit stored
    fields/methods.
23. Use inheritance only for categorization, not shared-field reuse.
24. Pass a Pydantic/config model through function boundaries when it already
    represents the payload; avoid parallel parameter lists that drift as fields
    are added.

### D) Serialization contracts

25. Ensure fields are JSON-serializable.
26. Prefer `Annotated[..., PlainSerializer(...)]` over `@field_serializer`
    decorator pattern.
27. Use `serialization_alias`/`alias` for external naming contracts.
28. Exclude runtime-only fields with `Field(exclude=True)` and conditional
    `exclude_if`.
29. Use `model_dump(exclude_unset=True)` for sparse/patch payloads.
30. Use `model_dump(exclude_none=True)` to omit `None` values.
31. For immutable updates, use `model_copy(update={...})`; use `deep=True` when
    nested references must be cloned.

### E) Config

32. Use `pydantic-settings` for config; do not hand-parse `os.environ`/dotenv.

## Workflow

1. Identify the canonical owner of the data: existing package model, infrasys
   `System` entity, external schema, config, or new local internal value.
2. Identify boundary: internal vs external vs config vs infrasys entity.
3. Pick model type using quick router.
4. Apply non-negotiable rules.
5. Add only needed validators/serializers.
6. Add focused tests (valid + invalid + serialization). For metadata such as
   units, prefer serialization/behavior assertions over introspecting private
   annotation internals.
7. Check migration/compatibility impact and whether downstream functions should
   consume the model object directly to avoid field drift.

See:

- [references/REFERENCE.md](./references/REFERENCE.md) for full copy-paste
  patterns.
- [references/EXAMPLES.md](./references/EXAMPLES.md) for bad -> good snippets.
- [references/QUICKMAP.md](./references/QUICKMAP.md) for fast intent -> pattern
  lookup.
- `evals/train-trigger-prompts.json` and `evals/validation-trigger-prompts.json`
  for trigger tuning.
- `evals/evals.json` for output-quality checks.

## Output

- Chosen model type and reason.
- Exact field/constraint/serialization patterns applied.
- Validation + serialization implications.
- Risks and migration notes.
