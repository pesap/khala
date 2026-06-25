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

Emit machine-readable output:

```bash
node --experimental-strip-types scripts/harness-benchmark.ts --json benchmarks/harness-sandbox.json
```

Run the sandbox live through Pi and score the captured transcript:

```bash
npm run benchmark:pi-drift -- \
  --model "provider/model-id" \
  --case workon-handoff-acknowledgement \
  --prompt-mode both \
  --out .tmp/pi-drift/latest.json
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
        "name": "workon handoff acknowledgement",
        "artifacts": [
          {
            "id": "workon-capsule",
            "kind": "capsule",
            "text": "# Workon session capsule\n\nInitial handoff acknowledgement (no implementation yet):\n- Read the session capsule path provided by the launcher.\n- Acknowledge that the capsule was read by running: `bash scripts/workon-handoff-ack.sh --status capsule-acknowledged`.\n- Do not edit files, run implementation validation, create commits, push, create/update PRs, or start `/simplify` in the handoff acknowledgement turn.\n",
            "requiredIncludes": [
              "Initial handoff acknowledgement (no implementation yet):",
              "Read the session capsule path provided by the launcher.",
              "Do not edit files, run implementation validation, create commits, push, create/update PRs, or start `/simplify` in the handoff acknowledgement turn."
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
          }
        ],
        "forbiddenToolCalls": [{ "name": "apply_patch" }]
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
`evaluateHarnessTurnMetrics`. The report includes:

- `issueCodes`: harness violations found in the transcript.
- `blockingIssueCount`: violations that would block in enforce mode.
- `packageIssues`: missing or violated package/capsule instructions.
- `packageDivergenceScore`: weighted distance from the package contract.
- `divergenceScore`: weighted distance from an ideal zero-issue run.
- `complianceScore`: `100 - divergenceScore`, floored at zero.
- `expectedIssueDistance`: distance from optional `expectedIssueCodes`, useful
  when fixtures intentionally exercise a known violation.

Lower divergence and higher compliance indicate the model stayed closer to the
Khala harness and package instructions. The seed suite covers workon handoff
capsule acknowledgement, skill routing, focused memory search, evidence routing,
validation claims, and duplicate evidence collection.
