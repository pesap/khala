import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  listLearnedWorkflows,
  readLearnedWorkflow,
} from "../learning/workflows.ts";
import type { LearningPaths } from "../learning/store.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type WorkflowRecord = Awaited<ReturnType<typeof readLearnedWorkflow>>;

function splitNameAndRest(args: string | undefined): {
  name: string;
  rest: string;
} {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return { name: "", rest: "" };
  const [name = "", ...rest] = trimmed.split(/\s+/);
  return { name, rest: rest.join(" ").trim() };
}

export function createLearnedWorkflowCommandHandlers(params: {
  pi: ExtensionAPI;
  ensureLearningStore: (cwd: string) => Promise<LearningPaths>;
  notify: (
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
    message: string,
    type: NotifyType,
  ) => void;
}): {
  khalaReload: CommandHandler;
  workflowList: CommandHandler;
  workflowShow: CommandHandler;
  workflowRun: CommandHandler;
} {
  const sendWorkflowMessage = (
    ctx: ExtensionCommandContext,
    message: string,
    workflowName: string,
  ): void => {
    if (ctx.isIdle()) {
      params.pi.sendUserMessage(message);
      return;
    }
    params.pi.sendUserMessage(message, { deliverAs: "followUp" });
    params.notify(ctx, `Queued learned workflow ${workflowName}.`, "info");
  };
  const requireWorkflow = async (
    ctx: ExtensionCommandContext,
    args: string | undefined,
    usage: string,
  ): Promise<{ rest: string; workflow: NonNullable<WorkflowRecord> } | null> => {
    const { name, rest } = splitNameAndRest(args);
    if (!name) {
      params.notify(ctx, usage, "error");
      return null;
    }
    const workflow = await readLearnedWorkflow(await params.ensureLearningStore(ctx.cwd), name);
    if (!workflow) {
      params.notify(ctx, `Khala learned workflow not found: ${name}`, "error");
      return null;
    }
    return { rest, workflow };
  };

  return {
    khalaReload: async (_args, ctx) => {
      await ctx.reload();
    },

    workflowList: async (_args, ctx) => {
      const paths = await params.ensureLearningStore(ctx.cwd);
      const workflows = await listLearnedWorkflows(paths);
      if (workflows.length === 0) {
        params.notify(ctx, "No khala learned workflows found.", "info");
        return;
      }
      params.notify(ctx, `Khala learned workflows:\n${workflows.map((workflow) => `- ${workflow.name}`).join("\n")}`, "info");
    },

    workflowShow: async (args, ctx) => {
      const loaded = await requireWorkflow(ctx, args, "Usage: /workflow-show <name>");
      if (!loaded) return;
      const { workflow } = loaded;
      const prompt = workflow.promptText.trim();
      params.notify(
        ctx,
        [
          `Workflow ${workflow.record.name}:`,
          workflow.workflowText.trim(),
          prompt ? `\nPrompt template:\n${prompt}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },

    workflowRun: async (args, ctx) => {
      const loaded = await requireWorkflow(ctx, args, "Usage: /workflow-run <name> [input]");
      if (!loaded) return;
      const { workflow, rest } = loaded;
      const prompt = workflow.promptText.trim();
      const message = [
        `Run khala learned workflow \`${workflow.record.name}\`.`,
        "",
        "Workflow artifact:",
        "```yaml",
        workflow.workflowText.trim(),
        "```",
        prompt ? ["", "Prompt template:", "```markdown", prompt, "```"].join("\n") : "",
        "",
        `User input: ${rest || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n");

      sendWorkflowMessage(ctx, message, workflow.record.name);
    },
  };
}
