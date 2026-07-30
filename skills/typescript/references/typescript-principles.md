# TypeScript source-derived principles

Sources:

- TypeScript Handbook: Declaration Files Do's and Don'ts —
  https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
- 8 TypeScript CI Tweaks That Shave Off Seconds —
  https://medium.com/@ThinkingLoop/8-typescript-ci-tweaks-that-shave-off-seconds-23a4ec02305b
- CircleCI: Enforce type safety with TypeScript checks before deployments —
  https://circleci.com/blog/enforce-type-safety-with-typescript-checks-before-deployments/
- Thoughtspile: How we made our pre-commit check 7x faster —
  https://thoughtspile.github.io/2021/06/14/faster-pre-commit/

## Declaration and type API rules

### Prefer real primitives and safer unknowns

- Use `string`, `number`, `boolean`, and `symbol`, not boxed `String`, `Number`,
  `Boolean`, or `Symbol`.
- Use `object` for non-primitive values, not `Object`.
- Treat `any` as a local escape hatch for migration only. In established
  TypeScript, prefer `unknown` plus explicit narrowing.
- Do not define generic type parameters that are never used. They give false
  flexibility and can break inference.

### Callback signatures

- If a callback return value is ignored, type it as `void`, not `any`.
- Do not mark callback parameters optional unless the implementation may
  actually call the callback with fewer arguments.
- A consumer callback may always ignore extra parameters, so optional callback
  params are usually the wrong model.
- Do not write overloads that differ only by callback arity; use one signature
  with the maximum meaningful arity.

### Overload design

- Order overloads from most specific to most general. The compiler picks the
  first matching overload.
- Prefer optional parameters when overloads only vary by trailing arguments and
  share a return type.
- Prefer union parameters when overloads only vary by one argument type.
- Keep separate overloads when return type genuinely changes by argument shape
  and a union would lose useful inference.

## CI type-safety gate

Minimum quality gate:

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
```

CI should install dependencies and run the typecheck script before merge or
deployment. In CircleCI-style YAML, the essential job is:

```yaml
jobs:
  type-check:
    docker:
      - image: cimg/node:20.18
    steps:
      - checkout
      - run: npm ci
      - run: npm run typecheck
```

Use the project package manager (`npm ci`, `pnpm install --frozen-lockfile`,
`yarn install --immutable`) and lockfile policy.

## CI speed tactics

Use these in order of safety and fit:

1. **Separate type-check and emit**
   - `tsc --noEmit` verifies types.
   - esbuild/swc or project tooling emits JS quickly.
   - Run independent jobs/scripts in parallel when CI supports it.

2. **Project references for multi-package repos**
   - Use `composite: true`, `incremental: true`, and `tsc -b`.
   - Cache per-project `.tsbuildinfo` files.
   - Build only changed projects and dependents when graph tooling exists.

3. **Cache compiler and dependency work**
   - Cache package-manager store or `node_modules` according to platform
     guidance.
   - Cache `**/*.tsbuildinfo`.
   - Include lockfiles, `tsconfig*.json`, compiler version, OS, Node version,
     and build-tool config in cache keys.
   - Be careful caching `dist/`: safe when artifact validity is keyed by
     sources/config and the pipeline expects reuse.

4. **Tighten compiler scope**
   - Explicit `include` and `exclude` avoid accidental type-checking of
     generated files, tests, fixtures, or e2e trees.
   - Limit ambient types with `compilerOptions.types` when practical.
   - Keep `maxNodeModuleJsDepth: 0` unless JS dependency scanning is required.
   - Disable maps/declaration outputs in PR checks if not needed.

5. **Use speed tradeoffs deliberately**
   - `skipLibCheck` can speed CI by skipping dependency declaration checks. It
     is safer with pinned lockfiles and known-good `@types/*` versions.
   - `isolatedModules` helps single-file transforms remain safe, but it is not a
     substitute for `tsc --noEmit`.
   - Declaration emit belongs in release/library pipelines when PR latency
     matters.

6. **Avoid double-compiling tests**
   - Keep type-check separate from test transpilation.
   - Use fast TS transforms in test runners where suitable.
   - Precompile tests once when that is simpler and repeatable.

## Pre-commit speed tactics

Slow hooks get bypassed. Target short, useful checks:

- Add `--cache` to ESLint and Stylelint and ignore cache files (`.eslintcache`,
  `.stylelintcache`) if they are written in repo root.
- Run independent checks concurrently with a cross-platform tool such as
  `concurrently` or `npm-run-all` instead of shell-only `cmd1 && cmd2 && cmd3`
  when parallelism is wanted.
- Use `tsc --noEmit --incremental` on TypeScript 4.0+ so type-only checks can
  reuse `.tsbuildinfo`.
- For Jest in hooks, prefer `jest --onlyChanged` / `jest -o` only when
  dependency detection remains accurate.
- Avoid importing broad barrel/root `index` modules inside the project if
  changed-test detection depends on file-level imports; root barrels can make
  every change look global.
- Split huge frequently changed utility modules so changed-test detection can
  stay granular.

## Review checklist

Ask:

- Is this a library type surface, app-only type hardening, CI gate, or speed
  issue?
- Does the change preserve runtime behavior?
- Is `any` contained and justified, or should it be `unknown` plus narrowing?
- Are overloads necessary, ordered correctly, and not hiding specific
  signatures?
- Does CI fail before deploy on type errors?
- Are PR checks fast enough to keep developers from bypassing hooks?
- Are caches keyed tightly enough to avoid stale type/build results?
