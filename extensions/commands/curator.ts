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
  async function refreshReport(paths: LearningPaths, nowIso: string): Promise<void> {
    await refreshCuratorReport({ paths, nowIso });
  }

  return {
    skillStatus: async (args, ctx) => {
      const skillName = normalizeArg(args);
      if (!skillName) {
        params.notify(ctx, "Usage: /skill-status <name>", "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const record = await readLearnedSkillMetadata(paths, skillName);
      if (!record) {
        params.notify(ctx, `Learned skill not found: ${skillName}`, "error");
        return;
      }
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
      const skillName = normalizeArg(args);
      if (!skillName) {
        params.notify(ctx, "Usage: /archive-skill <name>", "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const record = await archiveLearnedSkill({ paths, skillName });
      if (!record) {
        params.notify(ctx, `Active learned skill not found: ${skillName}`, "error");
        return;
      }
      await refreshReport(paths, params.nowIso());
      params.notify(
        ctx,
        `Archived learned skill ${record.metadata.name} to ${record.dir}.`,
        "success",
      );
    },

    restoreSkill: async (args, ctx) => {
      const skillName = normalizeArg(args);
      if (!skillName) {
        params.notify(ctx, "Usage: /restore-skill <name>", "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const record = await restoreLearnedSkill({ paths, skillName });
      if (!record) {
        params.notify(
          ctx,
          `Archived learned skill not found: ${skillName}`,
          "error",
        );
        return;
      }
      await refreshReport(paths, params.nowIso());
      params.notify(
        ctx,
        `Restored learned skill ${record.metadata.name} to ${record.dir}.`,
        "success",
      );
    },
  };
}
