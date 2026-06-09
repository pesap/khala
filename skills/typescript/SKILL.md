---
name: typescript
description: "Write, review, harden, or speed up TypeScript code and pipelines. Use when users ask about TypeScript type-safety, declaration files, tsconfig, tsc --noEmit, CI type gates, project references, incremental builds, faster pre-commit checks, typed callbacks, overload design, any/unknown, or TypeScript build/test performance."
license: MIT
---

## Use when
- Writing or reviewing TypeScript APIs, declaration files, exported types, callbacks, overloads, or generics.
- Tightening type safety in app, library, or CI code without changing runtime behavior.
- Adding or debugging `tsc --noEmit` checks in CI/CD before merge or deployment.
- Speeding TypeScript builds, pre-commit hooks, test loops, or monorepo CI.
- Designing `tsconfig` splits for local dev, PR checks, release builds, and declaration emit.

## Avoid when
- The task is JavaScript-only with no TypeScript configuration, type contract, or compiler behavior involved.
- Runtime bundling, minification, or browser compatibility dominates and type-checking is incidental.
- The user asks for framework-specific architecture where a React/Vue/Node skill is more direct.

## Instructions
1. Preserve runtime behavior unless the user asks for behavior change; type hardening should make contracts explicit, not invent semantics.
2. Prefer primitive types (`string`, `number`, `boolean`, `symbol`) over boxed types (`String`, `Number`, `Boolean`, `Symbol`); use `object` for non-primitives, not `Object`.
3. Avoid `any` in mature TypeScript. Use `unknown` at trust boundaries, then narrow before use. Permit temporary `any` only for migration with a containment plan.
4. Do not create unused generic parameters. Every generic must affect input, output, or relationship between types.
5. For callbacks whose result is ignored, use `void`, not `any`.
6. Do not mark callback parameters optional just because consumers may ignore them; callbacks may accept fewer parameters without optional markers.
7. Avoid overloads that differ only by callback arity. Prefer one signature with the maximum intended callback arity.
8. Order overloads from most specific to most general; TypeScript selects the first matching overload.
9. Collapse overloads with the same return type and trailing argument differences into optional parameters where valid.
10. Collapse overloads that differ only by one argument type into union parameters where valid.
11. Add a CI type gate with `tsc --noEmit` (usually via `npm run typecheck`) before deploy/merge; make pipeline fail on type errors.
12. For CI speed, separate type-check from emit: run `tsc --noEmit` for correctness and use esbuild/swc or project build tooling for fast emit when appropriate.
13. For multi-package repos, prefer project references, `composite`, `incremental`, and `tsc -b`; cache `**/*.tsbuildinfo` with lockfile and tsconfig-aware cache keys.
14. Keep `tsconfig` scopes tight: explicit `include`/`exclude`, avoid compiling tests twice, constrain ambient `types`, and keep `maxNodeModuleJsDepth` low unless needed.
15. Use `skipLibCheck` only as a deliberate speed tradeoff; safer when dependency and `@types/*` versions are pinned.
16. Enable `isolatedModules` when single-file transforms (esbuild, swc, test runners) are part of the toolchain; pair with full `tsc --noEmit` type-checking.
17. Split PR and release configs when declaration emit is expensive: fast PR checks, accurate release declarations.
18. For pre-commit checks, keep latency low enough that developers will not bypass hooks: cache linters, run independent checks concurrently, use TypeScript incremental builds, and run changed tests when reliable.

## Progressive disclosure
- Read `references/typescript-principles.md` for source-derived rules, CI patterns, pre-commit speed tactics, and tradeoffs.
- Use `evals/trigger-prompts.json` when refining trigger behavior.
- Use `evals/evals.json` when checking output quality for TypeScript review, hardening, or pipeline work.

## Output
- Type-safety changes or recommendations, with behavior-change risk called out.
- Compiler/config/CI commands touched.
- Performance tradeoffs (`skipLibCheck`, declarations, cache scope, changed-only checks).
- Validation: `tsc --noEmit` or equivalent, relevant tests/builds, and any manual checks if tools cannot run.
