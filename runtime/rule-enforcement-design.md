# Khala Runtime Rules And Memory Design

## Goal

Khala should separate remembered experience from executable operating constraints.

Memory records what happened and what was learned. Rules state what the agent must do at runtime. This split keeps durable facts from becoming an unbounded prompt blob, and it gives khala a clear path to enforce lessons that are important enough to affect behavior.

## Definitions

Memory is observational:

- Project facts, preferences, workflow outcomes, and lessons learned from evidence.
- May be noisy, redundant, low confidence, or superseded.
- Used for recall, search, promotion candidates, and self-improvement review.

Rules are operational:

- Short imperative constraints that change runtime behavior.
- Must have explicit triggers, scope, confidence, and lifecycle state.
- Can be injected into the prompt, checked by hooks, or both.

Examples:

- Memory: `Review PR #141 stalled after promising to draft inline comments.`
- Rule: `When the latest user request asks for file/tool work, do not end with a promise; call a relevant tool or ask one blocking question.`
- Memory: `git merge-base was incorrectly blocked as a mutation during review.`
- Rule: `Treat git merge-base and git diff commands as read-only unless they include a mutating subcommand or shell redirection.`

## Store Layout

Project-local store stays under `.pi/khala` when present, otherwise the global khala store is used.

```text
.pi/khala/
├── memory/
│   ├── MEMORY.md
│   ├── learning.jsonl
│   ├── khala-learning.jsonl
│   ├── lessons.jsonl
│   └── promotion-queue.md
├── rules/
│   ├── active.jsonl
│   ├── session.jsonl
│   ├── candidates.jsonl
│   ├── audit.jsonl
│   └── RULES.md
└── state.json
```

`memory/lessons.jsonl` remains the raw learned-lesson stream. `rules/candidates.jsonl` contains lessons that look actionable but are not yet enforced. `rules/active.jsonl` contains durable runtime rules. `rules/session.jsonl` contains rules that apply only to the current Pi session. `rules/RULES.md` is a user-editable view of active durable rules.

Global stores should use the same shape under `~/.pi/khala`.

## Rule Record

Rules should be structured so runtime code can select and audit them deterministically.

```ts
interface RuntimeRule {
  version: 1;
  id: string;
  scope: "repo" | "global";
  lifetime: "durable" | "session";
  status: "candidate" | "active" | "disabled" | "superseded";
  severity: "advisory" | "warn" | "enforce";
  trigger: string;
  instruction: string;
  rationale: string;
  evidenceIds: string[];
  source: "manual" | "promotion" | "policy" | "workflow";
  confidence: number;
  priority: number;
  createdAt: string;
  updatedAt: string;
  lastHitAt?: string;
  hitCount: number;
  supersedes?: string[];
  replacedBy?: string;
}
```

`trigger` is used for relevance matching. `instruction` is the prompt text. `severity` tells runtime whether to merely inject, warn, or block on violation. `lifetime` distinguishes durable rules from per-session rules. `evidenceIds` links back to memory records so rules remain explainable.

Rules are append-log records with replacement semantics. Editing a rule writes a new active record with the same stable `id` and a higher `updatedAt`, or a new `id` with `supersedes`/`replacedBy` when the meaning materially changes. Runtime resolves the effective rule set by taking the latest valid record per id, excluding disabled and superseded records.

## Promotion Flow

Memory becomes a rule only through promotion.

1. End-of-turn learning writes observations to `memory/learning.jsonl` and `memory/khala-learning.jsonl`.
2. Assessment identifies actionable lessons and writes them to `memory/lessons.jsonl`.
3. A rule proposer scans recent lessons and creates or updates `rules/candidates.jsonl`.
4. Promotion requires either explicit user approval or repeated high-confidence evidence.
5. Promotion writes a normalized record to `rules/active.jsonl` and appends an audit entry.
6. `rules/RULES.md` is regenerated from active rules for inspection.

Promotion should be conservative. A single incident can create a candidate, but active enforce rules should require high confidence, manual approval, or a built-in policy class.

Per-session rules skip durable promotion. They are created by commands, user corrections, or workflow state when the rule is only relevant to the current session. They are read from `rules/session.jsonl`, applied after durable rules, and cleared on session shutdown unless explicitly promoted.

## Runtime Selection

On `before_agent_start`, khala should load rules in three tiers:

1. Always-on packaged rules from `runtime/RULES.md`.
2. Active global rules from `~/.pi/khala/rules/active.jsonl`.
3. Active repo rules from `<repo>/.pi/khala/rules/active.jsonl`.
4. Active per-session rules from the current session state and `<repo>/.pi/khala/rules/session.jsonl`.

Selection should cap prompt injection:

- Always inject top safety rules.
- Add task-relevant rules by matching trigger text against the latest user request, workflow type, loaded skills, files, tool names, and recent errors.
- Cap active learned rules to 8-12 lines.
- Prefer session rules over repo rules, and repo rules over global rules, on conflict.
- Prefer higher severity, higher priority, newer `updatedAt`, and stronger relevance.

Injected prompt section:

```text
[ACTIVE RUNTIME RULES]
- R-001 enforce: When the user requests concrete tool work, do not stop after a promise; call a tool or ask one blocking question.
- R-002 warn: Treat git merge-base as read-only for memory-gate purposes.
```

Memory remains available separately as `[LEARNING MEMORY TAIL]` and `[LEARNED OPERATING RULES]`, but executable rules should be in `[ACTIVE RUNTIME RULES]`.

## Search Backend

Rules and memory should share the khala search backend.

Instead of building a special-purpose rule matcher, generalize `khala_search_memory` into a corpus search service with typed documents:

```ts
type SearchCorpusKind =
  | "memory"
  | "learning"
  | "lesson"
  | "rule"
  | "rule_candidate"
  | "skill"
  | "workflow";
```

The existing memory search can remain user-facing as `khala_search_memory`, but internally it should call a generalized `searchKhalaCorpus` function. Runtime rule selection should query the same backend with a task-specific query built from:

- latest user text
- workflow type and workflow id
- loaded skills
- planned or attempted tool names
- file paths and diff scopes
- recent tool errors and policy warnings

Rule documents should index `trigger`, `instruction`, `rationale`, `scope`, `severity`, and evidence snippets. Search results should preserve `kind` so runtime can select only rule records for enforcement while still allowing tools to search memory and rules together.

## Enforcement Points

Rules can be enforced in three places.

Prompt-time guidance:

- Inject concise rules before the turn starts.
- Best for behavioral defaults and reminders.

Tool-call gates:

- Evaluate rules against `tool_call` events.
- Best for command classification, destructive operations, memory freshness, and required preflight.

End-of-turn gates:

- Evaluate final assistant output against current obligations and active rules.
- Best for stalls, missing workflow footers, missing postflight, and incomplete memory-gate recovery.

Each rule should declare its intended enforcement surface:

```ts
type RuleSurface = "prompt" | "tool_call" | "agent_end";
```

Rules that cannot be checked mechanically should stay `advisory` or `warn`. `enforce` should be reserved for rules with reliable predicates.

## Memory Interaction

Runtime should not treat every memory lesson as a rule.

Memory is queried for context:

- `khala_read_memory` gives recent memory and active lessons.
- `khala_search_memory` retrieves older relevant memory.
- Memory search can explain why a rule exists.

Rules are selected for action:

- Active rules are loaded automatically.
- Candidate rules are not injected by default.
- Rule hits append to `rules/audit.jsonl`, not `memory/MEMORY.md`.
- Repeated rule hits can create memory observations, but only summarized to avoid feedback loops.
- Per-session rules are searched and selected with active durable rules, but expire at session end unless promoted.

This creates a one-way default flow:

```text
experience -> memory -> candidate rule -> active rule -> audit -> summarized memory
```

The audit stream should not recursively promote itself without a distinct user correction or workflow failure.

## Conflict Handling

Rules need explicit conflict behavior.

- Exact duplicate active rules are ignored.
- If two active rules share a trigger but conflict, session scope wins over repo scope, and repo scope wins over global scope.
- Higher severity wins only when the rule is more specific or manually approved.
- Superseded rules stay in the log but are not injected or enforced.
- A disabled rule is never auto-reactivated without a new candidate and audit entry.
- Replacement records are resolved before conflict checks. Only the effective latest active rule for each id participates in selection.

The runtime should emit a warning when conflicts are detected so users can inspect `rules/RULES.md`.

## User Editing

Users should be allowed to edit `rules/RULES.md`.

To make that safe, `RULES.md` should use a stable, parseable format:

```markdown
# Khala Active Rules

<!-- khala-rules-version: 1 -->

## R-001

- status: active
- scope: repo
- lifetime: durable
- severity: enforce
- trigger: user requests concrete tool-backed work
- instruction: Do not stop after promising tool work; call a relevant tool or ask one blocking question.
- rationale: Prevents stalled turns where the agent acknowledges work but does not act.
```

On startup or `/rule-reload`, khala should parse `RULES.md`, validate user edits, and append replacement records to `rules/active.jsonl`. Invalid edited rules should be ignored with a warning and left visible in the file with an error note on the next render.

Rules edited directly in JSONL are also valid, but `RULES.md` is the preferred human editing surface.

## Commands

Initial command surface:

| Command | Purpose |
| --- | --- |
| `/rule-list [--all]` | Show active rules, optionally candidates and disabled rules. |
| `/rule-show <id>` | Show rule, evidence, hits, and source memory records. |
| `/rule-promote <candidate-id> [--enforce|--warn|--advisory]` | Promote a candidate to active. |
| `/rule-session <trigger> => <instruction>` | Add a per-session active rule. |
| `/rule-replace <id> <field edits>` | Append a replacement record for an existing rule. |
| `/rule-disable <id> <reason>` | Disable an active rule and write an audit event. |
| `/rule-audit [--limit N]` | Show recent rule hits, blocks, and conflicts. |
| `/rule-reload` | Parse user edits from `rules/RULES.md` and append valid replacements. |

Rules should also be manageable by file edit, but commands make promotion and audit safer.

## Implementation Plan

Phase 1: storage and rendering

- Add `rulesDir`, `rulesActiveJsonl`, `rulesCandidatesJsonl`, `rulesAuditJsonl`, and `rulesMd` to `LearningPaths`.
- Add `rulesSessionJsonl` and session cleanup behavior.
- Initialize those files in `ensureLearningStore`.
- Add parsers for runtime rule records.
- Render and parse user-editable `rules/RULES.md`.
- Resolve replacement records into an effective rule set.

Phase 2: bootstrap selection

- Generalize `searchKhalaMemory` into a typed corpus search backend.
- Add `getActiveRuntimeRules(cwd, cache, context)` using the shared search backend.
- Inject selected rules in `getBootstrapPayload` as `[ACTIVE RUNTIME RULES]`.
- Keep current `[LEARNED OPERATING RULES]` for passive lesson context during migration.

Phase 3: rule hit audit

- Track which active rules are selected for a turn.
- Append hit/block/warn events to `rules/audit.jsonl`.
- Update `lastHitAt` and `hitCount` through replacement records.

Phase 4: enforcement predicates

- Convert existing hardcoded checks into named built-in rules where practical:
  - unsatisfied tool action obligation
  - memory-gate recovery
  - workflow footer requirement
  - mutating bash classification
- Keep low-level command safety checks as policy code, but attach rule ids to events.

Phase 5: promotion

- Generate candidates from high-confidence `khala-learning.jsonl` records.
- Require user approval for new enforce rules.
- Allow repeated low-risk warn/advisory rules to auto-promote after threshold.
- Allow per-session rules to be promoted to durable active rules.

## Open Questions

- Should active learned rules be shared globally by default, or should global promotion always require explicit user approval?
- How strict should `RULES.md` parsing be when a user edits the file by hand?
- Should per-session rules be stored only in Pi session entries, only in `rules/session.jsonl`, or both?
- Should replacement preserve the same id by default, or mint a new id whenever trigger or instruction changes?

## Success Criteria

- A user correction can become a candidate without immediately bloating runtime prompt context.
- Important recurring corrections can become active rules with evidence and auditability.
- Runtime uses only a small relevant rule set per turn.
- Mechanically checkable rules can block stalls and unsafe behavior.
- Memory remains useful for recall without becoming an unbounded policy surface.
