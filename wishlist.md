# Khala Wishlist

- [x] Simplify `/khala-health` output to the compact health, session
  configuration, and model profile view.
- [x] Color-code health/profile status lines so `OK` and `ERROR` are visible at
  a glance.
- [x] Add the built-in `peer-review` model profile using
  `github-copilot/opus4.7:high`.
- [x] Route the in-loop Reviewer Two pass through `peer-review`.
- [x] Show `peer-review` in model profiles with its routed usage.
- [x] Simplify `/khala-mode` to `enforce`, `warn`, and `ignore`.

Expected `/khala-health` shape:

```console
Khala health: OK

Session Configuration
=====================
- enabled: no
- memory_tool_limit: 15
- compliance: preflight=enforce, postflight=enforce, response=enforce

Model profiles
==============

- OK found at /Users/psanchez/.pi/agent/khala/workflow-model.yaml

- OK planning
  - model: github-copilot/gpt-5.5
  - thinking: xhigh
  - used by: /plan, /triage, /debug

- OK development
  - model: github-copilot/gpt-5.4-mini
  - thinking: medium
  - used by: /workon, /review

- OK peer-review
  - model: github-copilot/opus4.7
  - thinking: high
  - used by: /reviewer-two
```
