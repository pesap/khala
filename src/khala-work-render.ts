import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import type { KhalaWork } from "./khala-model.js";
import { KhalaWorkLaunchStatus } from "./khala-model.js";

type RenderableLaunchDetails =
	| Readonly<{ status: typeof KhalaWorkLaunchStatus.queued; workId: string; archivePath: string }>
	| Readonly<{
			status: typeof KhalaWorkLaunchStatus.materialized;
			workId: string;
			missionId: string;
			mandateId: string;
	  }>
	| Readonly<{
			status: typeof KhalaWorkLaunchStatus.held;
			workId: string;
			missionId: string;
			coordinationId: string;
			reason: string;
	  }>
	| Readonly<{
			status: typeof KhalaWorkLaunchStatus.starting;
			workId: string;
			executionId: string;
			missionId: string;
			executorName: string;
	  }>
	| Readonly<{
			status: typeof KhalaWorkLaunchStatus.launched;
			workId: string;
			executionId: string;
			missionId: string;
			executorName: string;
			destination: string;
	  }>;

function renderSubmitWorkStatus(details: RenderableLaunchDetails, work: KhalaWork, theme: Theme): string {
	if (details.status === KhalaWorkLaunchStatus.queued) {
		return [
			`${theme.fg("success", "Work queued")} ${theme.fg("muted", `"${work.title}"`)}`,
			`${theme.fg("muted", `Work ID: ${details.workId}`)}`,
			theme.fg("dim", "Executor: not assigned; admission and launch are pending."),
		].join("\n");
	}
	if (details.status === KhalaWorkLaunchStatus.materialized) {
		return [
			theme.fg("success", "Mission materialized"),
			`${theme.fg("muted", `Work ID: ${details.workId}`)}`,
			`${theme.fg("muted", `Mission ID: ${details.missionId}`)}`,
			`${theme.fg("muted", `Mandate ID: ${details.mandateId}`)}`,
			theme.fg("dim", "No Executor was created; compare current Work before launching."),
		].join("\n");
	}
	if (details.status === KhalaWorkLaunchStatus.held) {
		return [
			theme.fg("warning", "Work held by Coordination"),
			`${theme.fg("muted", `Work ID: ${details.workId}`)}`,
			`${theme.fg("muted", `Mission ID: ${details.missionId}`)}`,
			`${theme.fg("muted", `Coordination ID: ${details.coordinationId}`)}`,
			`${theme.fg("dim", details.reason)}`,
		].join("\n");
	}
	if (details.status === KhalaWorkLaunchStatus.starting) {
		return [
			theme.fg("success", "Mission launch starting"),
			`${theme.fg("muted", `Work ID: ${details.workId}`)}`,
			`${theme.fg("muted", `Mission ID: ${details.missionId}`)}`,
			`${theme.fg("muted", `Execution ID: ${details.executionId}`)}`,
			`${theme.fg("muted", `Executor: ${details.executorName}`)}`,
		].join("\n");
	}
	return [
		theme.fg("success", "Work launched"),
		`${theme.fg("muted", `Work ID: ${details.workId}`)}`,
		`${theme.fg("muted", `Mission ID: ${details.missionId}`)}`,
		`${theme.fg("muted", `Execution ID: ${details.executionId}`)}`,
		`${theme.fg("muted", `Executor: ${details.executorName}`)}`,
		`${theme.fg("dim", `Destination: ${details.destination}`)}`,
	].join("\n");
}

function renderExpandHint(theme: Theme): string {
	return theme.fg("dim", `… ${keyHint("app.tools.expand", "to expand")}`);
}

export { renderExpandHint, renderSubmitWorkStatus };
