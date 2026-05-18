import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NotifyType } from "./engine.ts";

export function notifyWorkflowStarted(
  ctx: ExtensionCommandContext,
  message: string,
  notify: (ctx: ExtensionCommandContext, message: string, type: NotifyType) => void,
): void {
  notify(ctx, message, "info");
}
