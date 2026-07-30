# Runs and logs

List recent workflow runs:

```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:

```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## Triage pattern

1. `gh run list` to find the failing run
2. `gh run view <id>` to identify the first failed job/step
3. `gh run view <id> --log-failed` to extract the first actionable error
4. only then inspect or patch workflow YAML

## Default approach

- Diagnose from the first actionable failing step, not from downstream fallout.
- Prefer reruns/checks when validation is cheaper than speculative YAML edits.
