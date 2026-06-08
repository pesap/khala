# SDOM Reference

This reference supports the `sdom` skill for the Storage Deployment Optimization Model.

## Canonical docs
- Repository: https://github.com/Omar0902/SDOM
- README: https://github.com/Omar0902/SDOM/blob/master/README.md
- Developer guide: https://github.com/Omar0902/SDOM/blob/master/docs/source/sdom_Developers_guide.md
- Input guide: https://github.com/Omar0902/SDOM/blob/master/docs/source/user_guide/inputs.md
- Running + outputs: https://github.com/Omar0902/SDOM/blob/master/docs/source/user_guide/running_and_outputs.md
- Parametric analysis: https://github.com/Omar0902/SDOM/blob/master/docs/source/user_guide/parametric_analysis.md

## Runbook
Use `uv`-based commands unless task constraints require otherwise.

```bash
uv run pytest
uv run pytest tests/<target_test>.py
uv run python <script>.py
```

For solver setup and behavior, inspect:
- `src/sdom/optimization_main.py`
- `src/sdom/io_manager.py`

For parametric sweeps:
- `src/sdom/parametric/study.py`
- `src/sdom/parametric/sweeps.py`
- docs page above (`parametric_analysis.md`)

## Code map (high-signal)
- `src/sdom/optimization_main.py`: model initialization dispatch and solve path.
- `src/sdom/initializations.py`: sets/parameters initialization.
- `src/sdom/models/formulations_*.py`: per-domain variables/constraints/expressions.
- `src/sdom/results.py`: result collection and export shaping.
- `src/sdom/parametric/`: Cartesian sweep orchestration.
- `tests/`: regression and feature behavior checks.

## Troubleshooting
- **Solver unavailable**: verify solver package/executable and `get_default_solver_config_dict` arguments.
- **Infeasible/non-optimal results**: capture termination condition and inspect infeasible constraints/logging outputs.
- **Unexpected objective deltas**: compare with baseline dataset + same solver options; reduce horizon to isolate.
- **Parametric instability**: run one case serially first, then fan out cores.
- **Schema/data mismatch**: cross-check expected CSV names/columns against the input guide and `io_manager` loader logic.
