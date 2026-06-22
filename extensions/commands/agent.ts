import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "../state/runtime.ts";

type NotifyType = "info" | "error" | "warning" | "success";
type CommandHandler = (args: string | undefined, ctx: ExtensionCommandContext) => Promise<void>;

export function createAgentCommandHandlers(params: {
  runtimeState: RuntimeState;
  setAgentEnabledState: (ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, enabled: boolean) => void;
  appendAgentStateEntry: (enabled: boolean) => void;
  clearPendingWorkflow: () => Promise<void> | void;
  runSessionEndHooks: (ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">) => Promise<void>;
  notify: (ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">, message: string, type: NotifyType) => void;
}): {
  endAgent: CommandHandler;
} {
  return {
    endAgent: async (_args, ctx) => {
      if (!params.runtimeState.agentEnabled) {
        return;
      }
      await params.clearPendingWorkflow();
      await params.runSessionEndHooks(ctx);
      params.setAgentEnabledState(ctx, false);
      params.appendAgentStateEntry(false);
    },
  };
}
