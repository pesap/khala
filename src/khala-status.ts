import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KhalaRole, type KhalaRoleValue } from "./khala-role.js";

function setKhalaStatus(context: ExtensionContext, sessionRole: KhalaRoleValue | null): void {
	const roleLabel = (sessionRole ?? "user").padEnd(10, " ");
	let roleColor: "accent" | "success" | "warning" | "muted" = "muted";
	if (sessionRole === KhalaRole.conclave) {
		roleColor = "accent";
	} else if (sessionRole === KhalaRole.executor) {
		roleColor = "success";
	} else if (sessionRole === KhalaRole.maintainer) {
		roleColor = "warning";
	}
	context.ui.setStatus(
		"khala",
		`${context.ui.theme.fg("dim", "khala")} ${context.ui.theme.fg("muted", "⁝")} ${context.ui.theme.fg(roleColor, roleLabel)}`,
	);
}

export { setKhalaStatus };
