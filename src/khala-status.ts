import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KhalaRole, type KhalaRoleValue } from "./khala-role.js";

function setKhalaStatus(context: ExtensionContext, sessionRole: KhalaRoleValue | null): void {
	let roleLabel: string = sessionRole ?? "user";
	let roleColor: "accent" | "success" | "warning" | "muted" = "muted";
	if (sessionRole === KhalaRole.conclave) {
		roleColor = "accent";
	} else if (sessionRole === KhalaRole.executor || sessionRole === KhalaRole.observer) {
		roleColor = "success";
		roleLabel = context.sessionManager.getSessionName() ?? roleLabel;
	}
	const paddedRoleLabel = roleLabel.padEnd(10, " ");
	context.ui.setStatus(
		"khala",
		`${context.ui.theme.fg("dim", "khala")} ${context.ui.theme.fg("muted", "⁝")} ${context.ui.theme.fg(roleColor, paddedRoleLabel)}`,
	);
}

export { setKhalaStatus };
