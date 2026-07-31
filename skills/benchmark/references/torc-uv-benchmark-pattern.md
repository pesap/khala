# Torc + uv benchmark pattern

Adapted from
`/Users/psanchez/work/nodal-allocation/benchmarks/ptdf-calculation/`. Copy the
harness design, not the PTDF-specific math.

## Reference layout

```text
benchmark-name/
├── README.md
├── benchmark_workflow.yaml
├── benchmark_common.py
├── benchmark_<implementation_a>.py
├── benchmark_<implementation_b>.py
├── summarize_results.py
├── .gitignore
└── results/                 # generated, usually ignored unless curated
```

Use domain-specific prefixes when they improve readability, such as
`ptdf_common.py`, `ptdf_workflow.yaml`, and `summarize_ptdf_results.py`.

## File responsibilities

| File                     | Responsibility                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| `README.md`              | Benchmark question, files, prerequisites, run commands, settings, and results. |
| `*_workflow.yaml`        | Torc setup jobs, warm jobs, parameter matrix, and resource monitoring.         |
| `*_common.py`            | Deterministic inputs, typed summaries, parsing, validators, and JSON helpers.  |
| `*_<implementation>.py`  | One implementation per file with `run_benchmark` and sorted JSON stdout.       |
| `summarize_*_results.py` | Reads runner metrics and raw JSON; writes CSV and README results.              |
| `.gitignore`             | Ignores generated result directories and workflow databases.                   |

## Torc workflow shape

Use variables for paths and dimensions:

```yaml
variables:
  script_root: "."
  results_dir: "${BENCHMARK_RESULTS_DIR:-torc_output/results}"
  problem_sizes: "[100,1000,10000]"
  tolerance: "1e-8"
```

Prefer this job sequence:

1. `prepare_results_dir` creates `setup/` and `raw/` under the results
   directory.
2. `setup_locked_env` runs the locked dependency setup once, such as
   `uv sync --locked --no-dev`.
3. `setup_<implementation>` runs a tiny implementation smoke job and writes JSON
   under `setup/`.
4. `run_<implementation>_<params>` jobs depend on setup and write raw JSON under
   `raw/`.

Enable runner-side metrics rather than embedding timing in scripts:

```yaml
resource_monitor:
  enabled: true
  granularity: summary
  sample_interval_seconds: 1
  jobs:
    enabled: true
    granularity: summary
```

Use a shared resource requirement for comparable jobs unless the benchmark
question explicitly compares resource classes.

## Python benchmark script contract

For Python benchmarks, keep scripts importable and reproducible:

- Add `from __future__ import annotations`.
- Use dataclasses or `TypedDict` for inputs, computation summaries, and JSON
  payloads.
- Parse CLI flags first; environment variables are fallback defaults for direct
  ad hoc runs.
- Provide `run_benchmark(...) -> BenchmarkSummary` so tests can call the
  implementation.
- Validate inputs before running and validate outputs before reporting success.
- Print `json.dumps(payload, sort_keys=True)` from the
  `if __name__ == "__main__"` block.
- Send diagnostics to stderr or runner logs, not stdout.

A minimal payload should include correctness information that can reject invalid
winners:

```json
{
  "all_cases_valid": true,
  "checksum": 123.0,
  "iterations_avg": 42.5,
  "iterations_max": 100,
  "residual_norm_max": 1e-9
}
```

Use domain-specific names when clearer: `all_rows_converged`, `error_norm_max`,
`records_per_second`, `objective_gap`, etc.

## Summarizer pattern

The summarizer should combine two data sources:

1. Torc database/resource rows for return code, elapsed time, and peak memory.
2. Raw implementation JSON for domain correctness and algorithm metrics.

Recommended behavior:

- Resolve `BENCHMARK_RESULTS_DIR`, with a default under `torc_output/`.
- Resolve the Torc DB from either an explicit env var or
  `<results_dir>/torc.db`.
- Parse raw filenames into implementation and parameter values.
- Treat missing runner data as blank fields instead of fabricated values.
- Write `summary.csv` with stable columns.
- Replace README content only between result markers, for example:

```markdown
<!-- BENCHMARK_RESULTS_START -->

## Results

...

<!-- BENCHMARK_RESULTS_END -->
```

The generated block should include:

- source run path
- generation timestamp in UTC
- primary case or hardest-case selection rule
- winner criterion
- compact top table
- collapsible or secondary full-result tables when the matrix is large

## README runbook

Include these command classes:

```console
# Validate workflow expansion without running jobs
torc create --dry-run benchmark_workflow.yaml

# Default local run
torc -s --in-memory run benchmark_workflow.yaml
uv run --script summarize_results.py

# Named result directory with DB beside outputs
export BENCHMARK_RESULTS_DIR="results/my-run"
mkdir -p "$BENCHMARK_RESULTS_DIR"
torc -s --in-memory --db "$BENCHMARK_RESULTS_DIR/torc.db" \
    run -o "$BENCHMARK_RESULTS_DIR/torc_output" benchmark_workflow.yaml
uv run --script summarize_results.py
```

Also document how to reduce the matrix for smoke runs.

## Validation checklist

- `torc create --dry-run <workflow>` succeeds.
- One tiny setup/smoke job for each implementation emits valid JSON.
- At least one small full workflow run writes `raw/*.json` for each
  implementation.
- The summarizer writes `summary.csv` and updates only the generated README
  block.
- The README explains runtime settings, result paths, and what metrics mean.
- Generated artifacts are ignored or explicitly curated.
- The stated winner is selected only from correct/valid runs.
