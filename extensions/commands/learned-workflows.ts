import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  listLearnedWorkflows,
  readLearnedWorkflow,
} from "../learning/workflows";
import type { LearningPaths } from "../learning/store";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (
  args: string | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void>;

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
  return {
    khalaReload: async (_args, ctx) => {
      await ctx.reload();
      return;
    },

    workflowList: async (_args, ctx) => {
      const paths = await params.ensureLearningStore(ctx.cwd);
      const workflows = await listLearnedWorkflows(paths);
      if (workflows.length === 0) {
        params.notify(ctx, "No khala learned workflows found.", "info");
        return;
      }
      params.notify(
        ctx,
        `Khala learned workflows:\n${workflows.map((workflow) => `- ${workflow.name}`).join("\n")}`,
        "info",
      );
    },

    workflowShow: async (args, ctx) => {
      const { name } = splitNameAndRest(args);
      if (!name) {
        params.notify(ctx, "Usage: /workflow-show <name>", "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const workflow = await readLearnedWorkflow(paths, name);
      if (!workflow) {
        params.notify(ctx, `Khala learned workflow not found: ${name}`, "error");
        return;
      }
      params.notify(
        ctx,
        [
          `Workflow ${workflow.record.name}:`,
          workflow.workflowText.trim(),
          workflow.promptText.trim()
            ? `\nPrompt template:\n${workflow.promptText.trim()}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    },

    workflowRun: async (args, ctx) => {
      const { name, rest } = splitNameAndRest(args);
      if (!name) {
        params.notify(ctx, "Usage: /workflow-run <name> [input]", "error");
        return;
      }
      const paths = await params.ensureLearningStore(ctx.cwd);
      const workflow = await readLearnedWorkflow(paths, name);
      if (!workflow) {
        params.notify(ctx, `Khala learned workflow not found: ${name}`, "error");
        return;
      }
      const message = [
        `Run khala learned workflow \`${workflow.record.name}\`.`,
        "",
        "Workflow artifact:",
        "```yaml",
        workflow.workflowText.trim(),
        "```",
        workflow.promptText.trim()
          ? ["", "Prompt template:", "```markdown", workflow.promptText.trim(), "```"].join(
              "\n",
            )
          : "",
        "",
        `User input: ${rest || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n");

      if (ctx.isIdle()) {
        params.pi.sendUserMessage(message);
      } else {
        params.pi.sendUserMessage(message, { deliverAs: "followUp" });
        params.notify(ctx, `Queued learned workflow ${workflow.record.name}.`, "info");
      }
    },
  };
}
