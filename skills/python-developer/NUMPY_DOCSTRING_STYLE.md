# NumPy docstring style (required)

Use this style for every new or modified function/method.

## Minimum required content

1. One-line summary in imperative voice.
2. `Parameters` section (omit only if function takes no arguments).
3. `Returns` section (or `Yields` for generators).
4. `Raises` section when exceptions are part of contract.
5. `Examples` section with at least one runnable example using the project
   doctest-comment style: statement first, expected result on the next line as
   `# expected`.

## Template

```python
def transform_items(raw: str, *, strict: bool = True) -> list[str]:
    """Transform newline-delimited text into cleaned items.

    Parameters
    ----------
    raw : str
        Raw newline-delimited input.
    strict : bool, default=True
        Raise an error when no valid items are found.

    Returns
    -------
    list[str]
        Cleaned non-empty items.

    Raises
    ------
    ValueError
        If `strict=True` and no items are parsed.

    Examples
    --------
    >>> transform_items("a\\n\\n b ")
    # ['a', 'b']
    """
    items = [line.strip() for line in raw.splitlines() if line.strip()]
    if strict and not items:
        raise ValueError("input produced no items")
    return items
```

## Rules for examples

- Must be copy/paste runnable.
- Put expected results on the following line as a `#` comment, not as bare
  interactive output.
- Assert meaningful state: prefer examples like `solution.is_optimal()` followed
  by `# True`, or `round(value, 6)` followed by `# 11.0`.
- Must cover normal behavior (and include edge/error example when relevant).
- Keep short (1-4 lines each unless the API needs a short setup block).

## NumPy array contracts

For every public function that accepts or returns `numpy.ndarray`:

- State dtype when it matters.
- State shape using domain names, not just `(n,)`.
- Explain what each axis means.
- Do not document a long tuple of arrays. Replace it with a named dataclass and
  document each dataclass field.

Good:

```python
@dataclass(frozen=True)
class PTDFArrays:
    """Store named arrays derived from a benchmark system.

    Parameters
    ----------
    from_bus : Int32Array
        Full-network source bus index for each line. Shape is `(n_branches,)`.
    to_bus : Int32Array
        Full-network target bus index for each line. Shape is `(n_branches,)`.
    diag : FloatArray
        Reduced Laplacian diagonal after removing the slack bus. Shape is
        `(n_buses - 1,)`.
    """
```

Bad:

```python
def arrays_from_system(system: System) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return arrays."""
```

## Example style

```python
>>> import arco
>>> model = arco.Model()
>>> x = model.add_variable(bounds=arco.Bounds(lower=1.0, upper=float("inf")), name="x")
>>> y = model.add_variable(bounds=arco.Bounds(lower=2.0, upper=float("inf")), name="y")
>>> model.add_constraint(x + y >= 5.0, name="demand")
# Constraint('demand', Bounds(5, inf))
>>> model.minimize(3.0 * x + 2.0 * y)
>>> solution = model.solve(log_to_console=False)
>>> solution.is_optimal()
# True
>>> round(solution.objective_value, 6)
# 11.0
```

## Avoid

- Empty docstrings or placeholder `TODO` docstrings.
- Non-NumPy section headers (`Args:`, `Returns:`) unless project explicitly
  requires Google style.
- Examples that do not match actual return values.
- Long positional tuple returns for structured arrays.
