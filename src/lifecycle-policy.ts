import type { Execution, WorkView } from "./model.js";

export function isCancelledWork(work: WorkView): boolean {
	return work.state === "stopped" && work.stopReason === "cancelled";
}

export function isTerminalWork(work: WorkView): boolean {
	return work.state === "succeeded" || work.state === "stopped";
}

export function failedOrStoppedExecution(work: WorkView): boolean {
	return work.execution === undefined || work.execution.state === "failed" || work.execution.state === "stopped";
}

export function isActiveMission(work: WorkView): boolean {
	return work.missionState === "admitted" || work.missionState === "active";
}

export function isConcurrentExecution(state: Execution["state"] | undefined): boolean {
	return state === "queued" || state === "running" || state === "awaiting-review";
}

export function runtimeNeedsInspection(work: WorkView): boolean {
	const execution = work.execution;
	return execution?.pi !== undefined && (execution.state === "running" || execution.state === "awaiting-review");
}
