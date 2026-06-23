import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PolicyMode } from "../policy/first-principles.ts";

export type NotifyType = "info" | "error" | "warning" | "success";

const KHALA_MODE_COLORS: Record<PolicyMode, "accent" | "warning" | "error"> = {
  ignore: "accent",
  warn: "warning",
  enforce: "error",
};

export function formatKhalaStatusLabel(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  mode: PolicyMode,
): string {
  const value = ctx.hasUI
    ? ctx.ui.theme.fg(KHALA_MODE_COLORS[mode], mode)
    : mode;
  return `khala-mode: ${value}`;
}

export function setKhalaStatus(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  label?: string,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("khala", label);
}

export function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
  type: NotifyType,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type === "success" ? "info" : type);
    return;
  }

  const line = `[khala/${type}] ${message}`;
  if (type === "error" || type === "warning") {
    console.error(line);
    return;
  }

  console.log(line);
}
