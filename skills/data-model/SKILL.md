---
name: data-model
description: Design robust data contracts with dataclasses, Pydantic v2, pydantic-settings, and infrasys component patterns. Use when users ask about model shape, validation, serialization, typed config, schema evolution, or cleaning up loose dict/schema/model code into explicit typed contracts, even if they do not name Pydantic or dataclasses directly.
license: MIT
---

# Data Model

## Use when
- Designing/refactoring typed domain models.
- Choosing between `@dataclass`, Pydantic, settings, or infrasys component models.
- Defining field constraints, validators, serializers, aliases, or payload filtering.
- Creating generic typed response/container models.
- Updating schemas safely with backward compatibility in mind.
- Cleaning up loose dict/schema/model code into explicit validated contracts.
- Making config typed, fixing serialization shape, or tightening a weak data boundary.

## Avoid when
- Task is not about data contracts.
- User wants one-off scripting with no reusable model boundary.
- Domain requirements are still undefined.

## Quick router
1. Simple trusted internal data -> `@dataclass`.
2. External validated/serialized data -> Pydantic v2 `BaseModel`/`RootModel`.
3. App config/env -> `pydantic-settings` (`BaseSettings`).
4. infrasys system entities -> `Component` / `SupplementalAttribute`.

## Guidance levels
- **Repo convention / default**: follow these unless local code reality or the user explicitly wants a different contract.
- **General modeling guidance**: use judgment where multiple good patterns exist.

## Non-negotiable rules

### A) Core modeling
1. Prefer typed models (`@dataclass` or Pydantic) over loose dicts.
2. Use **Pydantic v2 only**.
3. Use `Annotated[...]` for modeled fields.
4. Put full type hint inside `Annotated`.
5. Use `Field(...)` for constrained fields.
6. In this repo, include `description=` in `Field(...)` unless there is a strong local reason not to.
7. Never use `typing.Union[...]`; use `A | B`.

### B) Type quality
8. Prefer built-in Pydantic semantic/constrained types before custom aliases (`PostgresDsn`, `PositiveFloat`, `EmailStr`, etc.).
9. For finite domains, prefer `Enum` over free-form strings.
10. If field drifts to `str | None` blob, extract nested model.
11. For repeated float constraints, create typed alias only if built-ins do not fit.
12. For mutable defaults (`list`, `dict`, `set`), use `Field(default_factory=...)`.

### C) Validation/behavior
13. Use `field_validator` / `model_validator` (v2).
14. Use `model_dump` / `model_validate` (v2).
15. Check field existence with `Model.model_fields`.
16. Avoid `@computed_field` for core behavior; use explicit stored fields/methods.
17. Use inheritance only for categorization, not shared-field reuse.

### D) Serialization contracts
18. Ensure fields are JSON-serializable.
19. Prefer `Annotated[..., PlainSerializer(...)]` over `@field_serializer` decorator pattern.
20. Use `serialization_alias`/`alias` for external naming contracts.
21. Exclude runtime-only fields with `Field(exclude=True)` and conditional `exclude_if`.
22. Use `model_dump(exclude_unset=True)` for sparse/patch payloads.
23. Use `model_dump(exclude_none=True)` to omit `None` values.
24. For immutable updates, use `model_copy(update={...})`; use `deep=True` when nested references must be cloned.

### E) Config
25. Use `pydantic-settings` for config; do not hand-parse `os.environ`/dotenv.

## Workflow
1. Identify boundary: internal vs external vs config vs infrasys entity.
2. Pick model type using quick router.
3. Apply non-negotiable rules.
4. Add only needed validators/serializers.
5. Add focused tests (valid + invalid + serialization).
6. Check migration/compatibility impact.

See:
- [references/REFERENCE.md](./references/REFERENCE.md) for full copy-paste patterns.
- [references/EXAMPLES.md](./references/EXAMPLES.md) for bad -> good snippets.
- [references/QUICKMAP.md](./references/QUICKMAP.md) for fast intent -> pattern lookup.
- `evals/train-trigger-prompts.json` and `evals/validation-trigger-prompts.json` for trigger tuning.
- `evals/evals.json` for output-quality checks.

## Output
- Chosen model type and reason.
- Exact field/constraint/serialization patterns applied.
- Validation + serialization implications.
- Risks and migration notes.
