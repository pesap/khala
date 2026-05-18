import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LearningPaths } from "../learning/store.ts";
import {
  appendRuntimeRule,
  appendRuleAudit,
  makeRuntimeRule,
  readEffectiveRuntimeRules,
  readRuntimeRuleRecords,
  readRuleAuditTail,
  refreshRulesMarkdown,
  reloadRulesMarkdown,
} from "../learning/rules.ts";
import type {
  RuntimeRule,
  RuntimeRuleSeverity,
} from "../learning/rules.ts";
import { normalizeWhitespace } from "../lib/text.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export interface RuleCommandHandlers {
  ruleList: CommandHandler;
  ruleShow: CommandHandler;
  rulePromote: CommandHandler;
  ruleSession: CommandHandler;
  ruleReplace: CommandHandler;
  ruleDisable: CommandHandler;
  ruleAudit: CommandHandler;
  ruleReload: CommandHandler;
}

export function createRuleCommandHandlers(params: {
  ensureLearningStore: (cwd: string) => Promise<LearningPaths>;
  nowIso: () => string;
  notify: (
    ctx: ExtensionCommandContext,
    message: string,
    type: NotifyType,
  ) => void;
}): RuleCommandHandlers {
  async function getRules(ctx: ExtensionCommandContext): Promise<{
    paths: LearningPaths;
    rules: RuntimeRule[];
  }> {
    const paths = await params.ensureLearningStore(ctx.cwd);
    return { paths, rules: await readEffectiveRuntimeRules(paths) };
  }

  function parseSeverity(value: string | undefined): RuntimeRuleSeverity {
    if (value === "advisory" || value === "warn" || value === "enforce") {
      return value;
    }
    return "warn";
  }

  return {
    ruleList: async (args, ctx) => {
      const paths = await params.ensureLearningStore(ctx.cwd);
      const includeAll = /\b--all\b/.test(args ?? "");
      const visible = includeAll
        ? await readRuntimeRuleRecords(paths)
        : await readEffectiveRuntimeRules(paths);
      if (visible.length === 0) {
        params.notify(ctx, "No active khala runtime rules.", "info");
        return;
      }
      params.notify(
        ctx,
        `Khala runtime rules:\n${visible
          .map(
            (rule) =>
              `- ${rule.id} [${rule.status}/${rule.severity}/${rule.lifetime}/${rule.scope}] ${rule.trigger} => ${rule.instruction}`,
          )
          .join("\n")}`,
        "info",
      );
    },

    ruleShow: async (args, ctx) => {
      const id = normalizeWhitespace(args ?? "");
      if (!id) {
        params.notify(ctx, "Usage: /rule-show <id>", "error");
        return;
      }
      const { rules } = await getRules(ctx);
      const rule = rules.find((entry) => entry.id === id);
      if (!rule) {
        params.notify(ctx, `Khala runtime rule not found: ${id}`, "error");
        return;
      }
      params.notify(ctx, JSON.stringify(rule, null, 2), "info");
    },

    rulePromote: async (args, ctx) => {
      const raw = normalizeWhitespace(args ?? "");
      const [id, ...flags] = raw.split(/\s+/);
      if (!id) {
        params.notify(
          ctx,
          "Usage: /rule-promote <candidate-id> [--enforce|--warn|--advisory]",
          "error",
        );
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const candidate = (await readRuntimeRuleRecords(paths)).find(
        (entry) => entry.id === id && entry.status === "candidate",
      );
      if (!candidate) {
        params.notify(ctx, `Khala rule candidate not found: ${id}`, "error");
        return;
      }
      const severityFlag = flags.find((flag) => /^--/.test(flag));
      const severity = parseSeverity(severityFlag?.replace(/^--/, ""));
      const now = params.nowIso();
      const promoted: RuntimeRule = {
        ...candidate,
        status: "active",
        lifetime: "durable",
        severity,
        updatedAt: now,
      };
      await appendRuntimeRule(paths, promoted);
      await appendRuleAudit(paths, {
        version: 1,
        id: `audit-${now}`,
        ruleId: promoted.id,
        at: now,
        action: "promote",
        detail: `Promoted candidate ${promoted.id} as ${promoted.severity}.`,
      });
      await refreshRulesMarkdown(paths);
      params.notify(ctx, `Promoted rule ${promoted.id}.`, "success");
    },

    ruleSession: async (args, ctx) => {
      const raw = args ?? "";
      const match = raw.match(/^\s*(.*?)\s*=>\s*(.*?)\s*$/);
      if (!match?.[1]?.trim() || !match[2]?.trim()) {
        params.notify(
          ctx,
          "Usage: /rule-session <trigger> => <instruction>",
          "error",
        );
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const rule = makeRuntimeRule({
        lifetime: "session",
        trigger: normalizeWhitespace(match[1]),
        instruction: normalizeWhitespace(match[2]),
        rationale: "Per-session rule added by user.",
        nowIso: params.nowIso(),
      });
      await appendRuntimeRule(paths, rule);
      params.notify(ctx, `Added session rule ${rule.id}.`, "success");
    },

    ruleReplace: async (args, ctx) => {
      const raw = normalizeWhitespace(args ?? "");
      const [id, ...tokens] = raw.split(/\s+/);
      if (!id || tokens.length === 0) {
        params.notify(
          ctx,
          "Usage: /rule-replace <id> key=value [key=value ...]",
          "error",
        );
        return;
      }
      const { paths, rules } = await getRules(ctx);
      const previous = rules.find((entry) => entry.id === id);
      if (!previous) {
        params.notify(ctx, `Khala runtime rule not found: ${id}`, "error");
        return;
      }
      const edits = new Map<string, string>();
      for (const token of tokens) {
        const index = token.indexOf("=");
        if (index <= 0) continue;
        edits.set(token.slice(0, index), token.slice(index + 1));
      }
      const now = params.nowIso();
      const replacement: RuntimeRule = {
        ...previous,
        severity: edits.has("severity")
          ? parseSeverity(edits.get("severity"))
          : previous.severity,
        trigger: edits.get("trigger") ?? previous.trigger,
        instruction: edits.get("instruction") ?? previous.instruction,
        rationale: edits.get("rationale") ?? previous.rationale,
        updatedAt: now,
      };
      await appendRuntimeRule(paths, replacement);
      await refreshRulesMarkdown(paths);
      params.notify(ctx, `Replaced rule ${id}.`, "success");
    },

    ruleDisable: async (args, ctx) => {
      const [id, ...reasonParts] = normalizeWhitespace(args ?? "").split(/\s+/);
      if (!id) {
        params.notify(ctx, "Usage: /rule-disable <id> <reason>", "error");
        return;
      }
      const { paths, rules } = await getRules(ctx);
      const previous = rules.find((entry) => entry.id === id);
      if (!previous) {
        params.notify(ctx, `Khala runtime rule not found: ${id}`, "error");
        return;
      }
      const now = params.nowIso();
      await appendRuntimeRule(paths, {
        ...previous,
        status: "disabled",
        rationale: reasonParts.join(" ") || previous.rationale,
        updatedAt: now,
      });
      await appendRuleAudit(paths, {
        version: 1,
        id: `audit-${now}`,
        ruleId: previous.id,
        at: now,
        action: "disable",
        detail: reasonParts.join(" ") || "Rule disabled by user.",
      });
      await refreshRulesMarkdown(paths);
      params.notify(ctx, `Disabled rule ${id}.`, "success");
    },

    ruleAudit: async (args, ctx) => {
      const limitMatch = (args ?? "").match(/(?:^|\s)--limit\s+(\d+)(?=\s|$)/);
      const limit = Math.max(
        1,
        Math.min(100, Number.parseInt(limitMatch?.[1] ?? "20", 10)),
      );
      const paths = await params.ensureLearningStore(ctx.cwd);
      const events = await readRuleAuditTail(paths, limit);
      if (events.length === 0) {
        params.notify(ctx, "No khala rule audit events.", "info");
        return;
      }
      params.notify(
        ctx,
        `Khala rule audit:\n${events
          .map(
            (event) =>
              `- ${event.at} [${event.action}] ${event.ruleId}: ${event.detail}`,
          )
          .join("\n")}`,
        "info",
      );
    },

    ruleReload: async (_args, ctx) => {
      const paths = await params.ensureLearningStore(ctx.cwd);
      const count = await reloadRulesMarkdown({
        paths,
        nowIso: params.nowIso(),
      });
      params.notify(ctx, `Reloaded ${count} rule(s) from rules/RULES.md.`, "success");
    },
  };
}
