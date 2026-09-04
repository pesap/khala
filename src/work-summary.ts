import type { WorkSummary, WorkView } from "./model.js";

export function workSummary(work: WorkView, queuePositions: ReadonlyMap<string, number>): WorkSummary {
	return {
		workId: work.workId,
		title: work.terms.title,
		state: work.state,
		stopReason: work.stopReason,
		missionState: work.missionState,
		executionState: work.execution?.state,
		hasFailure: [
			work.lastError !== undefined,
			work.state === "stopped" && work.stopReason === "failed",
			work.execution?.state === "failed",
		].some(Boolean),
		revision: work.revision,
		queuePosition: queuePositions.get(work.workId),
		budget: work.budget,
		nextAction: work.nextAction,
	};
}
