# MVP design

## Intent

Khala is a quiet forge for bounded coding work that continues while the User focuses elsewhere.
The normal experience is assign, work, review: validated commits or an explicit reason progress stopped, with useful work preserved.
It extends Pi rather than creating another conversation or dashboard to supervise.

This design describes where Khala is going and the boundaries that must hold, not a claim that every requirement is implemented.
The detailed documents below own their respective contracts; sections explicitly labelled current implementation describe the existing tools rather than the target.
Implementation changes must update the corresponding contract and verification evidence together.

## Non-negotiables

The [foundations](foundations.md) define three pillars: lifecycle sustains progress, data model sustains memory, and interaction sustains agency.
Each part of the work must preserve these guarantees:

- The Archive is authoritative; agents, runtime, Git, providers, and views supply evidence or projections, not permission.
- Work is isolated from the User's active checkout and unrelated resources; unavailable isolation blocks launch.
- Changed Mission terms require User approval; scope, publication, and allowances never expand silently.
- Results have exact-head validation and review evidence; readiness is not acceptance.
- Interrupted writers are confirmed stopped before replacement; unfinished work and its explanation survive interruption.
- All child roles operate within authorized token, concurrency, and correction limits.
- Pi interaction stays quiet, keyboard-first, draft-preserving, and honest about pending or disconnected operations.

These guarantees apply from the first working loop, not as later hardening.
The design does not authorize Archive migrations, automatic consolidation, deletion of existing Work, or a weaker isolation mode.

## Scope and responsibilities

The target has one shared Archive and one logical Conclave per User installation, supporting independent Missions across assigned repositories.
Each Mission targets one repository and has at most one active Execution.
The [glossary](glossary.md) defines the vocabulary without prescribing implementation.

| Role | Responsibility |
| --- | --- |
| User | Intent, boundaries, changed-term approval, feedback, allowance changes, and acceptance policy |
| Conclave | Admission, bounded correction, result judgment, and Outcome settlement |
| Executor | One bounded implementation attempt and evidence-bearing Signals |
| Observer | Optional read-only gathering of missing repository facts |
| Oracle | Optional independent advisory review, without tools |
| Application code | Authorization enforcement, launches, accounting, persistence, and delivery mechanics |

Feedback corrects the current Mission.
Only User-confirmed reusable guidance informs future Missions.
Roles support delegation; they do not create a hierarchy the User must administer.

## Delivery and acceptance

Local commits are the default and require neither code-host credentials nor publication.
The User accepts the exact reviewed head in Pi; acceptance does not merge or modify the User's checkout.

Authorizing provider delivery records permission to publish and explicitly delegates acceptance to the repository's merge process, including its permitted maintainers and automation.
Verified merge evidence represents acceptance without a second confirmation in Pi.
It does not authorize Khala to merge code.

Both modes retain Conclave Outcome settlement before Work becomes `succeeded`.
The [lifecycle contract](lifecycle.md#acceptance-and-settlement) owns the evidence, state, and insufficient-budget rules.

## Build from one working loop

Begin with a small assignment that can be completed, reviewed, interrupted, and recovered safely.
Expand from that loop without weakening authorization, isolation, accounting, evidence, or persistence.
The first two parts belong together before Khala can be relied on for delegation.

| Part | What it makes possible | How to check it |
| --- | --- | --- |
| 1. Local delegation | One repository, one Executor, concurrency one, local commits, explicit acceptance | Submit bounded intent, clarify it, produce validated commits, review, correct, and accept without publication |
| 2. Safe continuity | Cancellation, crash recovery, supervisor restart, retained work, disconnected interaction | Close Pi and reconnect; interrupt validation and the worker; preserve results, drafts, and decisions without duplicating a writer or effect |
| 3. Independent parallel work | Multiple repositories with shared supervision and enforced limits | Independent branches progress within total capacity and budget limits without sharing unauthorized context or writable ownership |
| 4. Provider delivery | Authorized publication, delegated acceptance, monitoring, then bounded provider feedback | Verify exact-result merges, stale feedback, base drift, duplicate delivery, and provider failures without expanding authority |
| 5. Reusable guidance | Explicit promotion, scoped retrieval, pinned versions, withdrawal | New Missions receive only applicable approved guidance; withdrawal excludes it from new Missions without rewriting existing agreements |

Provider delivery targets GitHub Pull Requests and GitLab Merge Requests.
GitHub provider-comment delivery is included; GitLab status and merge observation are included without GitLab provider-comment delivery.
Explicit Pi feedback is available for either delivery mode.

## Reading map and ownership

Each detailed rule has one authoritative home.
Other documents link to that home rather than maintaining competing specifications.

| Document | Owns |
| --- | --- |
| [Foundations](foundations.md) | Intent, pillars, and enduring guarantees |
| [Glossary](glossary.md) | Canonical terminology |
| [Lifecycle](lifecycle.md) | Admission, clarification, amendments, execution, review, acceptance, cancellation, and recovery transitions |
| [Data model](data-model.md) | Identities, immutable contracts, records, review snapshots, guidance versions, and projections |
| [TUI navigation](tui-navigation.md) | User journeys, navigation, editing, confirmations, attention, and disconnected behavior |
| [Architecture](architecture.md) | Application boundary, ports, supervision, scheduling, and external-effect reconciliation |
| [Operations](operations.md) | Configuration, allowances, concurrency, state locations, startup, backup, and troubleshooting |
| [Security](security.md) | Role authority, process isolation, resource access, validation, provider trust, and publication permissions |

[Getting started](getting-started.md) and [Application actions](supervision-tools.md) describe use of the current tools, not proof that the design is complete.
[Development](development.md) owns repository validation commands; [Role prompts](role-prompts.md) covers prompt maintenance, not lifecycle authority.

## Evidence before expanding

Do not call work complete from document review or a worker's final message.
Exercise the checks above and the relevant fault cases in the detailed contracts before expanding autonomy.
Measure peak process-tree memory and per-role tokens per reviewed result; model price is not evidence of runtime efficiency.

Do not claim learned quality improvement or default-enable model-policy changes without a versioned task-specific held-out set of at least 30 cases and a same-harness baseline.
Tune on separate development cases and do not use Conclave self-grading as release evidence.
Report task success, critical errors, unsupported claims, required-schema failures, p50/p95 latency, cost per success, confidence intervals, and model, prompt, tool, sampling, and data versions.
Release evidence requires at least 95% success, zero critical errors, unsupported claims, and required-schema failures, and no quality regression greater than one percentage point against baseline.

## Exclusions

The MVP excludes automatic merge, automatic token top-up, unbounded correction loops, generic semantic retry, priority controls, dependency scheduling, semantic peer-conflict detection, multi-repository Missions, non-Git VCS, provider webhooks, and more than one active Execution per Mission.
Writable-workspace exclusion is required; it does not imply semantic conflict detection between independent branches.
No additional per-role, per-provider, or per-primitive specification hierarchy is required.
