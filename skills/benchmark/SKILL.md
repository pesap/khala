---
name: benchmark
description:
  Design, implement, run, and report reproducible software benchmarks using
  lightweight scripts, Torc workflows, uv-locked Python environments,
  machine-readable outputs, and generated README summaries. Use when users ask
  to create or improve benchmark suites, compare implementations or algorithms,
  measure runtime or memory, design benchmark workflows, summarize benchmark
  results, or copy the PTDF benchmark pattern.
license: MIT
---

# benchmark

## Use when

- Creating, improving, running, or diagnosing a benchmark suite.
- Comparing implementations, algorithms, libraries, solvers, or data-processing
  strategies.
- Measuring runtime, memory, convergence, iteration count, numerical accuracy,
  throughput, or code size.
- Designing reproducible orchestration with locked dependencies, setup
  separation, result folders, resource monitoring, and generated reports.
- The user mentions benchmark harnesses, performance comparison, parametric
  sweeps, profiling alternatives, warm-start timing, `summary.csv`, generated
  README results, or Torc workflows.

## Avoid when

- The task is a one-off optimization with no benchmark harness or comparison
  design; use the relevant language/developer skill first.
- The task is primarily Torc remote-worker, Slurm, or HPC operations; load
  `torc-hpc` as well.
- The task is package-manager or standalone script setup only; load `uv`,
  `python-developer`, `rust-developer`, or another implementation skill as
  appropriate.
- The user needs statistical experiment design beyond software benchmark harness
  mechanics.

## Workflow

1. State the benchmark question, implementations, input matrix, winner
   criterion, and correctness gates.
2. Inspect existing benchmark conventions before inventing a new layout.
3. Separate domain input generation from implementation code:
   - one common module for deterministic inputs, validation, CLI/env parsing,
     and JSON helpers
   - one script per implementation with a callable `run_benchmark` entry point
   - stdout reserved for sorted machine-readable JSON
4. Use reproducible execution:
   - lock dependencies with `uv sync --locked --no-dev`, `uv run --locked`, or
     the repo equivalent
   - use a workflow runner such as Torc for run orchestration and resource
     metrics when available
   - separate setup jobs from warm benchmark jobs
   - dry-run the workflow before full runs
5. Collect metrics in two layers:
   - runner metrics: elapsed time, return code, peak memory, job names, resource
     monitor data
   - domain metrics: convergence, iteration counts, residuals, checksums,
     throughput, or accuracy
6. Preserve raw data and publish generated summaries:
   - keep raw JSON outputs separate from setup outputs
   - write `summary.csv`
   - update only a generated README block between markers
   - label source run path and generation timestamp
7. Validate with a small smoke case, schema checks, correctness checks,
   summarizer idempotency, and generated-doc diff review.
8. Summarize results with fairness assumptions, caveats, and the exact commands
   needed to reproduce.

## Design rules

- Make benchmark inputs deterministic; document seeds, synthetic topology,
  dataset slices, or fixtures.
- Prefer CLI flags as the primary interface; use environment variables only as
  direct-run fallbacks.
- Validate correctness before ranking speed. Invalid, failed, or non-converged
  implementations cannot win.
- Do not mix dependency setup time into warm-run comparisons unless the question
  includes cold start.
- Do not trust ad hoc script self-timing when the runner can provide timing and
  memory consistently.
- For Python benchmark memory, use Torc resource monitoring. Do not use
  Python-level memory probes (`tracemalloc`, `resource`, `memory_profiler`,
  `psutil`) for benchmark memory numbers.
- Store raw results, logs, workflow DBs, and generated summaries in predictable
  result directories.
- Check in benchmark source, workflow, summarizer, and docs; ignore routine
  generated artifacts unless a curated result is intentionally published.

## Progressive disclosure

- Read `references/torc-uv-benchmark-pattern.md` when designing or scaffolding a
  new harness.
- Load `torc-hpc` for Torc remote workers, Slurm, HPC submission, or cluster
  artifact collection.
- Load `uv` for standalone script metadata, `uv run --script`, or lockfile
  details.
- Load the implementation-language skill when editing benchmark code.
- Load `docs-authoring` when results need user-facing documentation polish.

## Output

- Benchmark question and fairness assumptions
- Implementation/input matrix
- Harness files created or changed
- Smoke, dry-run, and full-run commands
- Metrics schema and correctness gates
- Results and summary locations
- Validation evidence
- Residual caveats or follow-up benchmark slices
