# Language Map Reference

**Always load this reference.** It provides language-specific thresholds,
anti-pattern catalogs, and tool references. Apply the rules matching the
languages in the reviewed diff.

---

## Python

### File-size thresholds

- Warning: 800 lines
- Blocker: 1200 lines

### Thin abstraction signals

- Single-method class with no state beyond what it wraps.
- `@property` that only returns `self._x` with no transformation or validation.
- `__init__` that only assigns arguments to `self` with no logic.
- Module that exists only to re-export from submodules (`__init__.py` with only
  imports).
- Function that only calls another function with the same arguments in the same
  order.

### Type anti-patterns (see also references/type-safety.md)

- `dict[str, Any]` at function boundaries.
- `# type: ignore` without comment explaining why.
- `typing.cast()` used to silence errors instead of fixing types.
- `Optional[X]` returned where the caller always expects a value.
- `Protocol` with a single method — use `Callable` or a callback type.

### Tool references

- Lint: `ruff check`
- Type check: `mypy` or `pyright`
- Dead code: `vulture`, `ruff check --select F811`
- Dep graph: `pydeps`, `import-linter`

---

## TypeScript / JavaScript

### File-size thresholds

- Warning: 1000 lines
- Blocker: 1500 lines
- Component files (React/Vue/Svelte): warning at 500 lines, blocker at 800

### Thin abstraction signals

- Component that only passes props through to a single child.
- Interface that has exactly one implementation and is not exported.
- `export default function wrapper(props) { return <Inner {...props} />; }`
- Type alias that is just `type Foo = Bar` with no added constraints.
- Barrel file that only re-exports without adding or filtering.

### Type anti-patterns (see also references/type-safety.md)

- `any` at any exported symbol.
- `as` cast without a type guard or runtime check before it.
- `!` (non-null assertion) on a value received from outside the function.
- `as unknown as T` — double cast to bypass type system.
- `Record<string, any>` used as a public contract.
- `Partial<T>` where callers need all fields.

### Tool references

- Lint: `eslint`
- Type check: `tsc --noEmit`
- Dead code: `knip`, `ts-prune`
- Dep graph: `madge`, `dependency-cruiser`

---

## Rust

### File-size thresholds

- Warning: 1200 lines
- Blocker: 2000 lines
- `impl` blocks inflate line count; trait impls in separate files don't count
  toward the parent.

### Thin abstraction signals

- Newtype with only `Deref` and no validation or new behavior.
- Module that only re-exports from submodules with `pub use`.
- Trait with a single implementor and no generic usage.
- Function that only wraps another function call with no added logic.

### Type anti-patterns (see also references/type-safety.md)

- `unwrap()` / `expect()` on a value from outside the function.
- `unsafe` block without `// SAFETY:` comment explaining the invariant.
- `Box<dyn Error>` where a concrete error enum would serve callers better.
- `transmute` used where `from_raw_parts` or safe conversion would work.
- `Clone` derived on a struct holding file handles, sockets, or locks.

### Tool references

- Lint: `clippy -- -D warnings`
- Type check: `cargo check`
- Dead code: `cargo udeps`, `cargo check` (warns on unused)
- Dep graph: `cargo tree`, `cargo-modules`

---

## Go

### File-size thresholds

- Warning: 800 lines
- Blocker: 1200 lines
- Idiomatic Go keeps files focused on a single concern.

### Thin abstraction signals

- Interface with a single method and a single implementation.
- Function that only calls another function with the same parameters.
- Package that only re-exports from sub-packages with no added value.
- Struct that only embeds another struct with no additional fields or methods.

### Type anti-patterns (see also references/type-safety.md)

- `interface{}` / `any` at exported function signatures.
- Type assertion `x.(T)` without the comma-ok pattern.
- `string` used for a finite set of values without named constants.
- `map[string]interface{}` where a struct exists.

### Tool references

- Lint: `golangci-lint run`
- Type check: `go vet`
- Dead code: `deadcode`, `golangci-lint` with `unused` linter
- Dep graph: `go mod graph`, `gocyclo`

---

## Multi-Language Repos

When the diff touches multiple languages:

1. Apply each language's thresholds independently (a 1000-line TypeScript file
   and a 1200-line Rust file have different severity).
2. For boundary crossings (TypeScript calling Python via API, Rust FFI into Go),
   check both sides: types must agree, error handling must propagate.
3. Prefer the stricter threshold when unsure.

## Cross-Reference

After loading this reference, the dimension-specific references provide
language-aware rules for each severity level:

- `references/correctness.md` — C0-C3 rules. Use language thresholds from here
  to determine if a race condition is C1 or C2 in context.
- `references/security.md` — S0-S3 rules. Language choice affects injection
  surface (SQL in Python vs prepared statements in Rust).
- `references/structural-health.md` — T0-T3 rules. File-size gates are
  language-specific (see thresholds above).
- `references/type-safety.md` — D0-D3 rules. Per-language anti-patterns in this
  reference override the generic patterns in type-safety.md.
- `references/maintainability.md` — M0-M3 rules. Tool references in this file
  tell you which dead-code detector to run per language.
