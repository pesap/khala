import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  archiveLearnedSkill,
  readLearnedSkillMetadata,
  restoreLearnedSkill,
  setLearnedSkillPinned,
} from "../learning/skills.ts";
import type { LearningPaths } from "../learning/store.ts";
import { generateCuratorReport, refreshCuratorReport } from "../learning/curator.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

function normalizeArg(value: string | undefined): string {
  return (value ?? "").trim();
}

function parsePinArgs(args: string): {
  skillName: string;
  pinned: boolean;
  error?: string;
} {
  const trimmed = normalizeArg(args);
  if (!trimmed) {
    return { skillName: "", pinned: true, error: "Usage: /pin-skill <name> [on|off]" };
  }
  const [skillName, mode = "on"] = trimmed.split(/\s+/, 2);
  if (mode !== "on" && mode !== "off") {
    return { skillName, pinned: true, error: "Usage: /pin-skill <name> [on|off]" };
  }
  return { skillName, pinned: mode === "on" };
}

export function createCuratorCommandHandlers(params: {
  ensureLearningStore: (cwd: string) => Promise<LearningPaths>;
  nowIso: () => string;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
}): {
  skillStatus: CommandHandler;
  skillReport: CommandHandler;
  pinSkill: CommandHandler;
  archiveSkill: CommandHandler;
  restoreSkill: CommandHandler;
} {
  const refreshReport = (paths: LearningPaths, nowIso: string) =>
    refreshCuratorReport({ paths, nowIso });
  const requireSkillName = (
    ctx: ExtensionCommandContext,
    args: string | undefined,
    usage: string,
  ): string | null => {
    const skillName = normalizeArg(args);
    if (skillName) return skillName;
    params.notify(ctx, usage, "error");
    return null;
  };
  const notifyMissing = (ctx: ExtensionCommandContext, message: string) =>
    params.notify(ctx, message, "error");
  const runSkillMutation = async (paramsForMutation: {
    ctx: ExtensionCommandContext;
    args: string | undefined;
    usage: string;
    missingMessage: (skillName: string) => string;
    mutate: (params: {
      paths: LearningPaths;
      skillName: string;
    }) => Promise<{ metadata: { name: string }; dir: string } | null>;
    successMessage: (params: { name: string; dir: string }) => string;
  }): Promise<void> => {
    const skillName = requireSkillName(
      paramsForMutation.ctx,
      paramsForMutation.args,
      paramsForMutation.usage,
    );
    if (!skillName) return;
    const paths = await params.ensureLearningStore(paramsForMutation.ctx.cwd);
    const record = await paramsForMutation.mutate({ paths, skillName });
    if (!record) {
      return notifyMissing(
        paramsForMutation.ctx,
        paramsForMutation.missingMessage(skillName),
      );
    }
    await refreshReport(paths, params.nowIso());
    params.notify(
      paramsForMutation.ctx,
      paramsForMutation.successMessage({
        name: record.metadata.name,
        dir: record.dir,
      }),
      "success",
    );
  };

  return {
    skillStatus: async (args, ctx) => {
      const skillName = requireSkillName(ctx, args, "Usage: /skill-status <name>");
      if (!skillName) return;
      const paths = await params.ensureLearningStore(ctx.cwd);
      const record = await readLearnedSkillMetadata(paths, skillName);
      if (!record) return notifyMissing(ctx, `Learned skill not found: ${skillName}`);
      params.notify(
        ctx,
        `Skill ${record.metadata.name}: provenance=${record.metadata.provenance}, state=${record.metadata.state}, pinned=${record.metadata.pinned ? "yes" : "no"}, uses=${record.metadata.useCount}, patches=${record.metadata.patchCount}.`,
        "info",
      );
    },

    skillReport: async (_args, ctx) => {
      const paths = await params.ensureLearningStore(ctx.cwd);
      const nowIso = params.nowIso();
      await refreshReport(paths, nowIso);
      const report = await generateCuratorReport({
        paths,
        nowIso,
      });
      const headline = report.split(/\r?\n/).slice(0, 12).join("\n");
      params.notify(
        ctx,
        `Skill report refreshed at ${paths.curatorReport}.\n${headline}`,
        "info",
      );
    },

    pinSkill: async (args, ctx) => {
      const parsed = parsePinArgs(args ?? "");
      if (parsed.error) {
        params.notify(ctx, parsed.error, "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const record = await setLearnedSkillPinned({
        paths,
        skillName: parsed.skillName,
        pinned: parsed.pinned,
      });
      if (!record) {
        params.notify(ctx, `Learned skill not found: ${parsed.skillName}`, "error");
        return;
      }
      await refreshReport(paths, params.nowIso());
      params.notify(
        ctx,
        `Skill ${record.metadata.name} pin set to ${parsed.pinned ? "on" : "off"}.`,
        "success",
      );
    },

    archiveSkill: async (args, ctx) => {
      await runSkillMutation({
        ctx,
        args,
        usage: "Usage: /archive-skill <name>",
        missingMessage: (skillName) =>
          `Active learned skill not found: ${skillName}`,
        mutate: archiveLearnedSkill,
        successMessage: ({ name, dir }) =>
          `Archived learned skill ${name} to ${dir}.`,
      });
    },

    restoreSkill: async (args, ctx) => {
      await runSkillMutation({
        ctx,
        args,
        usage: "Usage: /restore-skill <name>",
        missingMessage: (skillName) =>
          `Archived learned skill not found: ${skillName}`,
        mutate: restoreLearnedSkill,
        successMessage: ({ name, dir }) =>
          `Restored learned skill ${name} to ${dir}.`,
      });
    },
  };
}
