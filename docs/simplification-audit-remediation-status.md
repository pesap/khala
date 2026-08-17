# Khala simplification audit remediation — implementation status

Source: docs/simplification-audit-remediation-plan.md. Every slice below was
implemented, validated (npm run check + build + full node --test suite), and
reviewed by a fresh gpt-5.6-terra max process with a bounded self-contained
packet. Reviewer findings were verified locally; fixes and regressions were
landed before closing each slice.

## Phase 1 (P0) — complete

| Slice | Finding | Commit(s) | Review |
| --- | --- | --- | --- |
| 1 | F-21 + F-17 Observer session markers | 5d59083, 67cd5bb | revise → fixed → pass |
| 2 | F-13 identity-safe RPC deregistration | d920d7d | pass |
| 3 | F-01 fail closed on retry handoffs | baa7266, b7bcb97 | pass (gaps closed) |
| 4 | F-06 Mission creation race (+F-15 no-op) | b75e529, 6d75be2 | revise → fixed → pass |
| 5 | F-12 single-flight supervision base polls | 2caa84f | pass |
| 6 | F-08 User PR ownership split | 8adf78c, ea61871, 9849c9c, b181edd | revise → fixed → pass |

## Phase 2 (P1) — complete

| Slice | Finding | Commit(s) | Review |
| --- | --- | --- | --- |
| 7 | F-22 clean before build | 1c34254 | pass (with 8) |
| 8 | F-03 bound model discovery | a524a6e, 01dc700 | revise → fixed → pass |
| 9 | F-25 Signal prompt contract | 11e9c7b | prompt-only (no code) |
| 10 | F-04 one snapshot per projection (+F-05) | d0bae2e, aa00bdf, 26d8a94 | revise → fixed → pass |

## Phase 3 (P2) — complete

| Slice | Finding | Commit(s) | Review |
| --- | --- | --- | --- |
| 11 | F-09 named wake direct claim | 9a3f13c | pass (with 12) |
| 12 | F-11 private coordination graph | caf4af6, 0d15998 | revise → fixed → pass |
| 13 | F-16 no nested registry reread | bd8170f | pass (with 14) |
| 14 | F-19 explicit clarify outcomes | 3ae7ffd, 1e10524 | revise → fixed → pass |
| 15 | F-23/F-24 automation simplification | 1eb94dc, 22d298e | revise → fixed → pass |
| 16 | F-26 ownership terminology | ba38ff3 | pass (with 15) |

## Phase 4 — NOT implemented (gated)

The plan gates these behind explicit decisions/approval that are not recorded
anywhere (checked the Khala Archive for the project; no decision records):

| Slice | Finding | Gate |
| --- | --- | --- |
| 17 | F-07 retire legacy v1 retry path | "Only after F-01 and explicit approval" |
| 18 | F-20 normalize pi-review active state | "After the persisted-state decision" |
| 19 | F-18 remove Oracle summary parser | "After consumer confirmation" |

## Final state

- 249 tests pass (was 222 at baseline), npm run check clean, prek run clean.
- No compatibility adapters, no persistent caches, no global indexes introduced.
- Explicit non-work honored: F-02/F-10/F-14/R-01 and the legacy launching/launched
  storage path untouched.
