import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendRuntimeRule,
  clearSessionRules,
  makeRuntimeRule,
  parseRulesMarkdown,
  readEffectiveRuntimeRules,
  readRuntimeRuleRecords,
  readRuleAuditTail,
  reloadRulesMarkdown,
  renderRulesMarkdown,
  resolveEffectiveRules,
  selectRuntimeRules,
} from "../../extensions/learning/rules.ts";
import { createRuleCommandHandlers } from "../../extensions/commands/rules.ts";
import { ensureLearningStore } from "../../extensions/learning/store.ts";
import { searchKhalaCorpus } from "../../extensions/learning/search.ts";
import { createTempLearningPaths } from "./helpers.ts";

const now = "2026-05-18T12:00:00.000Z";

test("learning store initializes runtime rule files", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "khala-rules-store-"));
  await fs.mkdir(path.join(cwd, ".pi"));
  const paths = await ensureLearningStore(cwd, new Map());

  assert.equal(await fs.readFile(paths.rulesActiveJsonl, "utf8"), "");
  assert.equal(await fs.readFile(paths.rulesSessionJsonl, "utf8"), "");
  assert.match(await fs.readFile(paths.rulesMd, "utf8"), /Khala Active Rules/);
});

test("runtime rules resolve replacements and ignore disabled records", () => {
  const base = makeRuntimeRule({
    id: "R-test",
    trigger: "old trigger",
    instruction: "old instruction",
    nowIso: now,
  });
  const replacement = {
    ...base,
    trigger: "new trigger",
    instruction: "new instruction",
    updatedAt: "2026-05-18T12:01:00.000Z",
  };
  const disabled = {
    ...replacement,
    status: "disabled" as const,
    updatedAt: "2026-05-18T12:02:00.000Z",
  };

  assert.deepEqual(resolveEffectiveRules([base, replacement]), [replacement]);
  assert.deepEqual(resolveEffectiveRules([base, replacement, disabled]), []);
});

test("rules markdown is user-editable and reloadable", async () => {
  const paths = await createTempLearningPaths("khala-rules-");
  const rule = makeRuntimeRule({
    id: "R-001",
    trigger: "tool work",
    instruction: "Call a tool before final response.",
    severity: "enforce",
    nowIso: now,
  });
  const markdown = renderRulesMarkdown([rule]).replace(
    "Call a tool before final response.",
    "Call a relevant tool before final response.",
  );
  await fs.writeFile(paths.rulesMd, markdown, "utf8");

  const parsed = parseRulesMarkdown(markdown, { nowIso: now });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].instruction, "Call a relevant tool before final response.");

  const count = await reloadRulesMarkdown({ paths, nowIso: now });
  assert.equal(count, 1);
  const active = await readEffectiveRuntimeRules(paths);
  assert.equal(active[0].instruction, "Call a relevant tool before final response.");
});

test("session rules are selected and cleared separately from durable rules", async () => {
  const paths = await createTempLearningPaths("khala-rules-");
  await appendRuntimeRule(
    paths,
    makeRuntimeRule({
      id: "R-durable",
      trigger: "review",
      instruction: "Use review rule.",
      nowIso: now,
    }),
  );
  await appendRuntimeRule(
    paths,
    makeRuntimeRule({
      id: "R-session",
      lifetime: "session",
      trigger: "linux subprocess issue",
      instruction: "Highlight Linux subprocess risk in review comments.",
      severity: "enforce",
      nowIso: now,
    }),
  );

  const selected = await selectRuntimeRules({
    paths,
    context: { query: "linux subprocess review comments" },
  });
  assert.equal(selected[0].id, "R-session");

  await clearSessionRules(paths);
  const remaining = await readEffectiveRuntimeRules(paths);
  assert.deepEqual(
    remaining.map((rule) => rule.id),
    ["R-durable"],
  );
});

test("corpus search indexes rules alongside memory", async () => {
  const paths = await createTempLearningPaths("khala-rules-search-");
  await fs.writeFile(paths.memoryMd, "review memory mentions linux\n", "utf8");
  await appendRuntimeRule(
    paths,
    makeRuntimeRule({
      id: "R-linux",
      trigger: "linux subprocess issue",
      instruction: "Draft inline comments about Linux subprocess risk.",
      nowIso: now,
    }),
  );

  const results = await searchKhalaCorpus({
    paths,
    query: "linux subprocess inline comments",
    limit: 5,
    snippetLength: 160,
  });

  assert.equal(results[0].kind, "rule");
  assert.match(results[0].snippet, /subprocess/);
});

test("rule add creates a durable active rule and refreshes markdown", async () => {
  const paths = await createTempLearningPaths("khala-rule-add-");
  const notices: string[] = [];
  const handlers = createRuleCommandHandlers({
    ensureLearningStore: async () => paths,
    nowIso: () => "2026-05-18T12:04:00.000Z",
    notify: (_ctx, message) => notices.push(message),
  });

  await handlers.ruleAdd(
    "rule persistence => Save durable rules directly --enforce",
    { cwd: paths.root } as never,
  );

  const [rule] = await readEffectiveRuntimeRules(paths);
  assert.equal(rule.trigger, "rule persistence");
  assert.equal(rule.instruction, "Save durable rules directly");
  assert.equal(rule.lifetime, "durable");
  assert.equal(rule.severity, "enforce");
  assert.match(await fs.readFile(paths.rulesMd, "utf8"), /Save durable rules directly/);
  assert.match(notices[0], new RegExp(paths.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("rule replacement preserves severity when severity edit is omitted", async () => {
  const paths = await createTempLearningPaths("khala-rule-replace-");
  await appendRuntimeRule(
    paths,
    makeRuntimeRule({
      id: "R-preserve",
      trigger: "review",
      instruction: "Use original instruction.",
      severity: "enforce",
      nowIso: now,
    }),
  );
  const handlers = createRuleCommandHandlers({
    ensureLearningStore: async () => paths,
    nowIso: () => "2026-05-18T12:05:00.000Z",
    notify: () => {},
  });

  await handlers.ruleReplace(
    "R-preserve instruction=Use-updated-instruction.",
    { cwd: paths.root } as never,
  );

  const [rule] = await readEffectiveRuntimeRules(paths);
  assert.equal(rule.severity, "enforce");
  assert.equal(rule.instruction, "Use-updated-instruction.");
});

test("rule disable reuses one timestamp for record and audit event", async () => {
  const paths = await createTempLearningPaths("khala-rule-disable-");
  await appendRuntimeRule(
    paths,
    makeRuntimeRule({
      id: "R-disable",
      trigger: "mutation",
      instruction: "Read memory first.",
      nowIso: now,
    }),
  );
  const handlers = createRuleCommandHandlers({
    ensureLearningStore: async () => paths,
    nowIso: () => "2026-05-18T12:06:00.123Z",
    notify: () => {},
  });

  await handlers.ruleDisable("R-disable obsolete", { cwd: paths.root } as never);

  const disabled = (await readRuntimeRuleRecords(paths)).find(
    (rule) => rule.id === "R-disable" && rule.status === "disabled",
  );
  const [audit] = await readRuleAuditTail(paths, 1);
  assert.equal(disabled?.updatedAt, "2026-05-18T12:06:00.123Z");
  assert.equal(audit.at, "2026-05-18T12:06:00.123Z");
  assert.equal(audit.id, "audit-2026-05-18T12:06:00.123Z");
});
