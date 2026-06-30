# Harness Benchmark Sandbox

The harness benchmark sandbox scores saved candidate transcripts against the
same end-of-turn checks that Khala uses at runtime. It also checks handoff
packages, session capsules, and ready-packet-style artifacts for required
content, then verifies whether the candidate transcript followed those package
instructions. It supports both saved transcript fixtures and live Pi runs, so
users can compare how closely different models follow the Khala harness and
where they diverge.

Run the seed suite:

```bash
npm run benchmark:harness
```

Run the deterministic golden CI gate:

```bash
npm run benchmark:harness:ci
```

Regenerate source-derived package contracts:

```bash
npm run benchmark:harness:contracts
```

Preflight a suite before scoring it:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts \
  --preflight \
  benchmarks/harness-sandbox.json
```

Emit machine-readable output:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts --json benchmarks/harness-sandbox.json
```

Filter deterministic reports and fail CI when any selected run diverges:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts \
  --case workon-worker-bootstrap \
  --model candidate/example \
  --fail-on-divergence \
  --out .tmp/harness/workon-bootstrap.md \
  benchmarks/harness-sandbox.json
```

Write or compare a CI baseline:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts \
  --json \
  --write-baseline .tmp/harness/baseline.json \
  benchmarks/harness-golden.json

node --experimental-strip-types scripts/harness-benchmark.ts \
  --baseline .tmp/harness/baseline.json \
  --fail-on-blocking-regression \
  --must-pass-tag golden \
  benchmarks/harness-golden.json
```

Run the sandbox live through Pi and score the captured transcript:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-id" \
  --case workon-worker-bootstrap \
  --prompt-mode both \
  --out .tmp/pi-drift/latest.json
```

Preflight a live drift run before spending model calls:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-id" \
  --case workon-worker-bootstrap \
  --preflight
```

Live drift runs do not have a builtin model default. Pass one or more models
with `--model`; repeat it or use a comma-separated list to compare multiple
models in one run. `--thinking` sets the default thinking level, and a model can
override it with a `:thinking` suffix:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-a,provider/model-b:high" \
  --thinking medium \
  --case workon-ready-packet-contract \
  --tools none
```

For reusable model sets, provide a newline file or JSON array with
`--model-file`:

```bash
npm run benchmark:pi-drift -- \
  --model-file .tmp/pi-drift/models.txt \
  --case workon-ready-packet-contract \
  --tools none
```

`--prompt-mode raw` sends the suite prompt with only sandbox path rewrites.
`--prompt-mode packaged` adds an explicit artifact manifest and stop-rule
checklist. Comparing the two modes shows whether workflow packaging changes
reduce drift for a model before changing the production handoff flow.

For content-only package checks, disable tools so the run isolates instruction
retention:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-id" \
  --case workon-ready-packet-contract \
  --prompt-mode packaged \
  --tools none \
  --timeout-ms 30000 \
  --out .tmp/pi-drift/ready-packaged.json
```

When `--out` is set, the live runner writes the generated suite after every
completed model run. Use `--resume` with the same output path to skip completed
run ids after an interruption:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-a,provider/model-b:high" \
  --case workon-worker-bootstrap \
  --prompt-mode both \
  --repeat 3 \
  --out .tmp/pi-drift/workon-bootstrap.json \
  --resume
```

`--repeat` gives deterministic looped sampling for each selected
case/model/prompt-mode combination. Repeated runs receive stable `-rN` run ids.
The runner also uses a deterministic sandbox state directory when `--out` is
set: `<out>.state`. Override it with `--state-dir` when you want the sandbox
artifacts somewhere else. Runs without `--out` still use temporary sandboxes and
clean them up by default.

The initial NLR HALO live drift run showed the ready-packet package contract
improved from package divergence `40` in raw mode to `0` in packaged mode for
all six NLR HALO models. Tool-enabled handoff acknowledgement runs against
`NLR/HALO Nemotron 3 Nano` and `NLR/HALO Devstral 123B` improved from package
divergence `40` in raw mode to `24` in packaged mode: the packaged prompt kept
the required final acknowledgement text, but both live transcripts still missed
the required `read` and acknowledgement command tool calls. The multiplexer
handoff prompt therefore repeats the capsule read path, exact acknowledgement
command, and required final acknowledgement text before the longer capsule
context.

## Suite Format

Suites are JSON files with benchmark cases and candidate runs:

```json
{
  "version": 1,
  "name": "Khala Harness Sandbox Seed Suite",
  "cases": [
    {
      "name": "Review task routes through the review skill",
      "userText": "Review this change for regressions.",
      "harnessLimits": { "substantialToolCallThreshold": 99 },
      "packageContract": {
        "name": "workon worker bootstrap",
        "artifacts": [
          {
            "id": "workon-capsule",
            "kind": "capsule",
            "text": "# Workon session capsule\n\nInitial handoff and readiness gate:\n- Read the session capsule path provided by the launcher.\n- Acknowledge that the capsule was read by running: `bash scripts/workon-handoff-ack.sh --status capsule-acknowledged`.\n- If no blocker is found, create/reuse the draft PR immediately with an empty bootstrap commit, then start the smallest scoped implementation slice without waiting for another operator instruction.\n",
            "requiredIncludes": [
              "Initial handoff and readiness gate:",
              "Read the session capsule path provided by the launcher.",
              "create/reuse the draft PR immediately with an empty bootstrap commit"
            ]
          }
        ],
        "requiredToolCalls": [
          { "name": "read", "argumentIncludes": ["capsule.md"] },
          {
            "name": "exec_command",
            "argumentIncludes": [
              "workon-handoff-ack.sh",
              "capsule-acknowledged"
            ]
          },
          {
            "name": "exec_command",
            "argumentIncludes": ["git commit", "--allow-empty"]
          },
          {
            "name": "exec_command",
            "argumentIncludes": ["gh pr create", "--draft"]
          }
        ],
        "forbiddenToolCalls": [{ "name": "apply_patch" }],
        "orderedToolCalls": [
          { "name": "read", "argumentIncludes": ["capsule.md"] },
          {
            "name": "exec_command",
            "argumentIncludes": [
              "workon-handoff-ack.sh",
              "capsule-acknowledged"
            ]
          },
          {
            "name": "exec_command",
            "argumentIncludes": ["git commit", "--allow-empty"]
          },
          {
            "name": "exec_command",
            "argumentIncludes": ["gh pr create", "--draft"]
          }
        ],
        "forbiddenBefore": [
          {
            "forbidden": { "name": "apply_patch" },
            "before": {
              "name": "exec_command",
              "argumentIncludes": ["gh pr create", "--draft"]
            }
          }
        ],
        "requiredBefore": [
          {
            "required": { "name": "read", "argumentIncludes": ["capsule.md"] },
            "before": {
              "name": "exec_command",
              "argumentIncludes": [
                "workon-handoff-ack.sh",
                "capsule-acknowledged"
              ]
            }
          }
        ],
        "nextToolMustBe": [
          {
            "after": { "name": "read", "argumentIncludes": ["capsule.md"] },
            "next": {
              "name": "exec_command",
              "argumentIncludes": [
                "workon-handoff-ack.sh",
                "capsule-acknowledged"
              ]
            }
          }
        ]
      },
      "runs": [
        {
          "id": "candidate-run",
          "model": "provider/model",
          "assistantText": "Final candidate answer text.",
          "messages": [
            { "role": "user", "text": "Review this change for regressions." },
            {
              "role": "assistant",
              "toolCall": {
                "name": "read",
                "arguments": { "path": "skills/design-quality-review/SKILL.md" }
              }
            },
            { "role": "toolResult", "text": "Skill instructions loaded." }
          ]
        }
      ]
    }
  ]
}
```

Each run is evaluated with `evaluateHarnessTurn` and
`evaluateHarnessTurnMetrics`. Internally, runs are first normalized into a
deterministic `KhalaTranscript`; existing `runs[].messages` fixtures still work,
and future fixtures may provide `runs[].transcript` directly. The report
includes:

- `issueCodes`: harness violations found in the transcript.
- `blockingIssueCount`: violations that would block in enforce mode.
- `transcriptEventCount`: normalized event count used for scoring and replay.
- `budget`: deterministic estimated context-budget components and advisory
  warnings.
- `packageIssues`: missing or violated package/capsule instructions.
- `packageDivergenceScore`: weighted distance from the package contract.
- `divergenceScore`: weighted distance from an ideal zero-issue run.
- `complianceScore`: `100 - divergenceScore`, floored at zero.
- `expectedIssueDistance`: distance from optional `expectedIssueCodes`, useful
  when fixtures intentionally exercise a known violation.

Lower divergence and higher compliance indicate the model stayed closer to the
Khala harness and package instructions. The seed suite covers workon handoff
capsule acknowledgement plus empty-commit draft PR bootstrap, skill routing,
focused memory search, evidence routing, validation claims, and duplicate
evidence collection.

## Transcript Replay

The benchmark normalizes every run into a `KhalaTranscript` before scoring.
Fixtures can still use `runs[].messages`; new fixtures may provide
`runs[].transcript` directly. The event model is append-only and deterministic:
events receive stable sequence numbers and ids, timestamps are optional, and
hashes use stable JSON serialization.

Core event families include user input, bootstrap payloads, workflow state, tool
calls, gate decisions, tool results, policy issues, skill events, memory gates,
assistant deltas/finals, ledger events, checkpoints, and budget samples. Only
the message-like subset is projected back into `evaluateHarnessTurn`, so runtime
policy logic stays in one place.

Use the JSONL helpers from `khala/harness` for replay files:

```ts
import {
  readKhalaTranscriptJsonl,
  writeKhalaTranscriptJsonl,
} from "khala/harness";

await writeKhalaTranscriptJsonl(".tmp/harness/run.jsonl", transcript);
const replay = await readKhalaTranscriptJsonl(".tmp/harness/run.jsonl");
```

JSONL files start with a `khala_transcript_start` metadata line, followed by one
`khala_event` object per event. Ledger-originated events may carry
`ledgerEventId` or `runLedgerId`; the transcript schema stays separate from the
run ledger schema.

## Fake Runner

`runKhalaHarnessScript` provides a deterministic fake runtime seam for tests. It
supports scripted user input, assistant deltas/finals, tool calls, gate
decisions, fake tool results, memory gates, skill routing/loading/missing
events, policy issues, checkpoints, ledger events, and budget samples. Blocked
tool calls emit block/result events without executing fake tools.

The runner does not simulate Pi. It exists to exercise Khala harness behavior
without a model, network call, or Pi process.

## Temporal Contracts

Package contracts can assert tool order using transcript event sequence numbers:

- `orderedToolCalls`: required calls must appear in the listed order.
- `forbiddenBefore`: a forbidden call must not occur before an anchor call.
- `requiredBefore`: a required call must occur before an anchor call.
- `nextToolMustBe`: the immediate next tool after an anchor must match.

Temporal failures use one-line package issue codes in Markdown:

- `package_run_tool_order_violation`
- `package_run_forbidden_tool_before_anchor`
- `package_run_required_tool_missing_before_anchor`
- `package_run_next_tool_mismatch`

The golden workon cases guard the bootstrap order: capsule read,
acknowledgement, empty bootstrap commit, draft PR, then implementation edits.

## Budget Estimates

Budget accounting is deterministic and advisory. The estimator uses
`Math.ceil(chars / 4)` over stable text/JSON renderings, not an external
tokenizer. Reports include component totals for bootstrap context, runtime
instructions, workflow prompt, skill payloads, handoff/capsule content, memory
tail, runtime rules, and transcript events. A `budgetWarningThreshold` on the
suite, case, run, or evaluation options adds Markdown warnings without changing
the compliance score.

## Generated And Golden Fixtures

`scripts/generate-harness-contracts.ts` reads checked-in source files and writes
`benchmarks/package-contracts.generated.json`. The current generator is narrow:
it derives a workon handoff contract from `commands/workon-handoff-template.md`
and a runtime instruction retention contract from `runtime/INSTRUCTIONS.md`.
Generated contracts include `sourcePath`, `sourceHash`, required includes,
required calls, and obvious temporal assertions.

`benchmarks/harness-golden.json` contains small deterministic cases tagged by
workflow and failure class. Some runs intentionally violate a harness or package
rule; those runs declare `expectedIssueCodes` or `expectedPackageIssueCodes` so
CI fails only on new or missing behavior.

## CI Flags

`scripts/harness-benchmark.ts` supports these CI-oriented flags:

- `--json`: emit the structured report.
- `--baseline <path>`: compare against a saved JSON report.
- `--write-baseline <path>`: write the current report as JSON.
- `--fail-on-blocking-regression`: fail when a run gains an unexpected blocking
  issue, or when blocking count exceeds the baseline.
- `--must-pass-tag <tag>`: require tagged cases to match expected harness and
  package issue codes.
- `--max-divergence <n>`: fail when any run exceeds a divergence ceiling.
- `--max-divergence-tag <tag=n>`: apply a divergence ceiling to tagged cases.

The JSON report includes issue counts by model, case, and tag, plus structured
budget values for each run. Live Pi drift remains opt-in through
`benchmark:pi-drift` and is not part of normal PR CI.
