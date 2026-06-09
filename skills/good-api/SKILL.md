---
name: good-api
description: "Evaluate or design developer-facing APIs using the learning-ladder model: flexible first, gradual second, convenient third. Use when users ask whether an API, SDK, CLI, library, schema, or interface is good, easy to learn, ergonomic, composable, beginner-friendly, enterprise-ready, or needs API design review."
license: MIT
---

## Use when
- Reviewing API, SDK, CLI, library, schema, or interface design.
- Designing a new API surface or simplifying an existing one.
- Diagnosing developer friction: hard onboarding, awkward second use case, poor composition, or expert escape hatches.
- Comparing convenience wrappers, defaults, layered APIs, and lower-level primitives.

## Avoid when
- The task is only implementation debugging with no API/interface design question.
- The user wants style preferences unrelated to developer learning or capability.
- Security, performance, compatibility, or domain correctness clearly dominates API ergonomics.

## Instructions
1. Name the target users: beginner, novice, expert, and enterprise/integration-heavy if relevant.
2. Assess the API as a learning ladder:
   - **Flexible**: experts can solve many real problems without hidden restrictions or forced eject paths.
   - **Gradual**: novices can learn one stable layer at a time; adding power does not contradict earlier semantics.
   - **Convenient**: beginners can solve the common case quickly with defaults, examples, or safe packaging.
3. Design or recommend changes in this order: flexible primitives first, gradual layers second, convenient wrappers/defaults third.
4. Check for hidden dependencies, restrictive coupling, oversimplified data models, and semantic surprises between layers.
5. Treat convenience wrappers as packaging over understandable primitives, not substitutes for a flexible model.

## Progressive disclosure
- Read `references/ladder-model.md` when you need the full vocabulary, failure modes, or source-derived questions.
- Use `evals/trigger-prompts.json` when refining trigger behavior.
- Use `evals/evals.json` when checking output quality for non-trivial API review cases.

## Output
- Ladder assessment: flexible / gradual / convenient.
- Top API risks, ranked by user impact.
- Concrete redesign recommendations.
- Tradeoffs and cases where convenience should win.
