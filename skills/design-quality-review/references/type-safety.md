# Type Safety Reference (D0–D3)

Load this reference when the diff contains `any`/`unknown`/casts, broad unions,
nullable without guards, untyped boundaries, or new type definitions.

## Review Priority Order

### D0: Unsound — Type System Lied To

Presumptive blocker. The code tells the type system something that is not true,
and this will cause a runtime crash or incorrect behavior.

- **Unsafe cast with no runtime guard**: `as` in TypeScript, `unwrap()` on
  `Option`/`Result` without checking, `unsafe` transmute in Rust that assumes
  layout, Python `typing.cast` used to silence a type error without validation.
- **`any` at a public API boundary that is consumed by external callers**:
  callers cannot know what shape to expect. Crash on access is inevitable.
- **Type-narrowing that can be wrong**: `if (x is Foo)` in Python where the
  check is structural and could pass for a different type with the same shape.
- **`as unknown as T` double-cast** in TypeScript: the author is knowingly
  bypassing the type system because the types don't align.

### D1: Brittle — Will Break Under Maintenance

Presumptive blocker.

- **`any` at a public API boundary** (return type, exported function parameter,
  public class field). Every consumer is forced to guess.
- **`unknown` at a public API boundary without documentation**: callers don't
  know what to narrow to.
- **Nullable without guard**: function returns `T | null` or `T | undefined` but
  every caller must null-check manually. Prefer making the boundary explicit
  (return `Result`, throw, or use a sentinel).
- **Broad union at a public boundary**: `string | number | boolean | object`
  where a narrower union or discriminated union exists.
- **`Partial<T>` or `Record<string, any>` used as a public contract**: the
  actual required fields are undocumented.

### D2: Weak — Could Be Tighter

- **Broad union where narrower exists**: `string | null` where `string` with
  empty sentinel works, or where `Option<string>` is more idiomatic.
- **Missing validation at input boundary**: API handler receives `unknown` and
  casts to a type without runtime validation. Add a validation layer (Pydantic,
  Zod, io-ts, etc.).
- **Optional fields that are always present in practice**: `field?` that is only
  optional because of an edge case that never occurs in the changed code path.
- **`as` cast that is safe now but would silently break if the source type
  changes**: add a comment or use a type guard instead.
- **Generic parameter that is always the same concrete type**: unnecessary
  abstraction that hides the actual contract.

### D3: Cosmetic — Could Be Cleaner

- Type alias that could be inlined without loss of clarity.
- Generic constraint slightly broader than necessary.
- `Record<string, T>` where `{ [key: string]: T }` would be identical.

## Boundary-First Analysis

Start from real boundaries, not internal implementation:

1. **Public API surface**: exported functions, classes, and types. What do
   callers need to know?
2. **Input boundaries**: HTTP handlers, CLI parsers, file readers, message
   consumers. Where does untrusted/untyped data enter?
3. **Output boundaries**: responses, file writes, message producers. What
   guarantees does the system make about output?
4. **Persistence boundaries**: database reads/writes, cache. Is the schema
   aligned with the types?
5. **Cross-module boundaries**: internal package boundaries. Are the types
   stable across version bumps?

For each boundary touched by the diff, check: are the types tight enough that a
caller cannot misuse them, and loose enough that they don't over-constrain the
implementation?

## Language-Specific Patterns

Consult `references/language-map.md` for language-specific anti-patterns. Common
patterns across languages:

### TypeScript

- `as` cast: flag if no runtime validation precedes it.
- `any`: flag at any exported symbol. Flag as D1 if it reaches a public
  boundary.
- `!` (non-null assertion): flag if the value comes from outside the function.
- `as const` missing on literal arrays/objects used as discriminants.
- `enums` vs `union types`: prefer string unions unless numeric enums are
  required by a protocol.

### Python

- `typing.cast(x, T)`: flag if x is not validated before the cast.
- `dict[str, Any]` where a TypedDict or dataclass/Pydantic model exists.
- `Optional[X]` (or `X | None`) without explicit None handling at call sites.
- `# type: ignore` comments: flag each one. Require justification.
- `Protocol` used where `ABC` or a simple callback type would be clearer.

### Rust

- `unwrap()` / `expect()` on values from outside the function: flag as D1.
- `unsafe` block: flag. Require `// SAFETY:` comment with invariant
  justification.
- `transmute`: flag as D0 unless the safety invariant is proven.
- `Box<dyn Error>` where a concrete error enum would give callers more control.
- `Clone` derived on types holding resources (file handles, connections).

### Go

- `interface{}` / `any` at exported function signatures: flag as D1.
- Type assertion `x.(T)` without comma-ok: flag as D0.
- `string` for enum-like values without named constants: flag as D2.
- `map[string]interface{}` where a struct exists: flag as D2.

## What Not to Flag as Type Issues

- Idiomatic use of dynamic types where the language and codebase expect it
  (e.g., Python `**kwargs` for decorators, Go `interface{}` for JSON
  intermediate representation).
- Generic complexity that is justified by multiple concrete use cases.
- "This could use a more specific type" when the specificity would require
  propagating changes through 50 files with no behavioral benefit.
