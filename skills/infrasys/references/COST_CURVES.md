# infrasys Cost Curves Reference

Use this document when modeling production variable cost or fuel behavior in
infrasys.

## Why use a cost curve

Use cost curves to represent **how operating level (x, usually MW)** maps to
**cost-like quantity (y)**.

- Capture non-linear economics (startup region, efficiency drop, convex
  heat-rate/cost growth).
- Keep solver input structured and typed (not ad hoc formulas).
- Convert among equivalent curve views when downstream interface requires
  specific form.

## Core hierarchy

- `FunctionData`
  - `LinearFunctionData`
  - `QuadraticFunctionData`
  - `PiecewiseLinearData`
  - `PiecewiseStepData`
- `ValueCurve`
  - `InputOutputCurve`
  - `IncrementalCurve`
  - `AverageRateCurve`
- `ProductionVariableCostCurve`
  - `CostCurve`
  - `FuelCurve`

---

## ValueCurve: what it is

`ValueCurve` adds **physical meaning** around `FunctionData`:

- `InputOutputCurve`: absolute mapping `y = f(x)`
  - Example: MW -> $/hr, or MW -> MBTU/hr.
- `IncrementalCurve`: marginal mapping `y = f'(x)`
  - Example: MW -> $/MWh, or MW -> MBTU/MWh.
- `AverageRateCurve`: average-rate mapping `y = f(x)/x`
  - Example: MW -> avg $/MWh.

`ValueCurve` also has optional `input_at_zero` for explicit non-origin behavior.

---

## FunctionData types and where each is supported

### Global `FunctionData` options

- `LinearFunctionData(proportional_term, constant_term, units=None)`
- `QuadraticFunctionData(quadratic_term, proportional_term, constant_term, units=None)`
- `PiecewiseLinearData(points=[XYCoords(x, y), ...], units=None)`
- `PiecewiseStepData(x_coords=[...], y_coords=[...], units=None)`

### By `ValueCurve` type

- `InputOutputCurve.function_data` supports:
  - `LinearFunctionData`
  - `QuadraticFunctionData`
  - `PiecewiseLinearData`
- `IncrementalCurve.function_data` supports:
  - `LinearFunctionData`
  - `PiecewiseStepData`
- `AverageRateCurve.function_data` supports:
  - `LinearFunctionData`
  - `PiecewiseStepData`

---

## CostCurve vs FuelCurve: when to use which

Use `CostCurve` when you already model variable operating cost in **currency
space**.

- Typical y-axis: `$/hr` (input-output) or `$/MWh` (incremental/average-rate).
- Best when market/objective consumes monetary cost directly.

Use `FuelCurve` when primary model is **fuel use** and cost conversion is
separate.

- Typical y-axis: `fuel/hr` or `fuel/MWh`.
- Use `fuel_cost` for fixed fuel price (or key/reference expected by your
  pipeline).
- Supports `startup_fuel_offtake` to model startup fuel consumption.

Quick rule:

- Need direct dispatch cost only -> `CostCurve`.
- Need fuel accounting, fuel-linked pricing, or startup fuel detail ->
  `FuelCurve`.

---

## Mandatory fields (and important defaults)

### `CostCurve`

Mandatory:

- `power_units`
- `value_curve`

Defaults:

- `vom_cost=LinearCurve(0.0)`

### `FuelCurve`

Mandatory:

- `power_units`
- `value_curve`

Defaults:

- `vom_cost=LinearCurve(0.0)`
- `fuel_cost=0.0`
- `startup_fuel_offtake=LinearCurve(0.0)`

### `IncrementalCurve` and `AverageRateCurve`

Mandatory constructor field:

- `initial_input` (can be `None`, but then conversion fails)

Conversion requirement:

- `initial_input` must be non-`None` before calling `.to_input_output()`.

---

## Curve conversion guide

### Supported built-in conversions

- `IncrementalCurve -> InputOutputCurve` via `.to_input_output()`
- `AverageRateCurve -> InputOutputCurve` via `.to_input_output()`

### Not provided as built-in

- `InputOutputCurve -> IncrementalCurve` (must derive manually)
- `InputOutputCurve -> AverageRateCurve` (must derive manually)
- `CostCurve <-> FuelCurve` direct converter (rewrap `value_curve` manually with
  different top-level class)

### Conversion details

#### 1) Incremental linear -> input-output

Given incremental `p*x + m` and `initial_input=c`:

- if `p == 0`: result is linear input-output with `(proportional=m, constant=c)`
- else: result is quadratic input-output with
  `(quadratic=p/2, proportional=m, constant=c)`

#### 2) Incremental stepwise -> input-output

`PiecewiseStepData` is integrated with running sum to produce
`PiecewiseLinearData`.

#### 3) Average-rate linear -> input-output

Given average-rate `p*x + m` and `initial_input=c`:

- if `p == 0`: result is linear input-output `(proportional=m, constant=c)`
- else: result is quadratic input-output
  `(quadratic=p, proportional=m, constant=c)`

#### 4) Average-rate stepwise -> input-output

For each segment endpoint, output y is built as `x * avg_rate`, with
`initial_input` inserted at first point.

### Conversion failure messages

- `"Cannot convert `IncrementalCurve`with undefined`initial_input`"`
- `"Cannot convert `AverageRateCurve`with undefined`initial_input`"`

---

## Validation rules for piecewise data

`PiecewiseLinearData` and `PiecewiseStepData` enforce:

1. At least 2 x-coordinates.
2. x-coordinates ascending.
   - Allowed exception: first x can be `NaN`, remaining x must be ascending.
3. For `PiecewiseStepData`: `len(y_coords) == len(x_coords) - 1`.

Common errors:

- `"Must specify at least two x-coordinates."`
- `"Piecewise x-coordinates must be ascending, got ..."`
- `"Must specify one fewer y-coordinates than x-coordinates"`

---

## Minimal patterns

```python
from infrasys.cost_curves import CostCurve, FuelCurve, UnitSystem
from infrasys.function_data import LinearFunctionData, PiecewiseStepData
from infrasys.value_curves import InputOutputCurve, IncrementalCurve, LinearCurve

# CostCurve in currency space
cost_curve = CostCurve(
    power_units=UnitSystem.NATURAL_UNITS,
    value_curve=InputOutputCurve(
        function_data=LinearFunctionData(proportional_term=25.0, constant_term=100.0)
    ),
    vom_cost=LinearCurve(2.0),
)

# FuelCurve in fuel space
fuel_curve = FuelCurve(
    power_units=UnitSystem.NATURAL_UNITS,
    value_curve=InputOutputCurve(
        function_data=LinearFunctionData(proportional_term=8.0, constant_term=50.0)
    ),
    fuel_cost=3.5,
    startup_fuel_offtake=LinearCurve(40.0),
)

# Incremental -> InputOutput conversion
inc = IncrementalCurve(
    function_data=PiecewiseStepData(x_coords=[0.0, 100.0, 200.0], y_coords=[5.0, 7.0]),
    initial_input=0.0,
)
io_curve = inc.to_input_output()
```

---

## Practical selection checklist

1. Pick semantic layer first:
   - absolute (`InputOutput`) vs marginal (`Incremental`) vs average
     (`AverageRate`).
2. Pick simplest `FunctionData` shape that fits data.
3. Choose top-level wrapper:
   - `CostCurve` for currency-native objective.
   - `FuelCurve` for fuel-native modeling + conversion via `fuel_cost`.
4. Set `power_units` explicitly.
5. For any planned conversion from incremental/average, ensure `initial_input`
   is defined.
6. Validate piecewise x ordering and lengths before attach to components.

---

## Inspect exact installed API quickly

If signatures drift across versions, inspect package source:

```bash
uvx --from python --with infrasys python - <<'PY'
import infrasys.cost_curves as cc
import infrasys.value_curves as vc
import infrasys.function_data as fd
print(cc.__file__)
print(vc.__file__)
print(fd.__file__)
PY
```
