import { existsSync } from "node:fs";
import { SQLiteArchive } from "./archive.js";
import type { WorkSummary, WorkView } from "./model.js";

export interface KhalaArchiveView {
	listWork: () => readonly WorkSummary[];
	inspectWork: (workId: string) => WorkView;
	close: () => void;
}

export function openKhalaArchive(path: string): KhalaArchiveView {
	if (!existsSync(path)) throw new Error(`Archive database ${path} does not exist.`);
	const archive = new SQLiteArchive(path, { readOnly: true });
	return {
		listWork: () => listWork(archive.listProjects()),
		inspectWork: (workId) => inspectWork(archive.listProjects(), workId),
		close: () => archive.close(),
	};
}

function listWork(projects: readonly WorkView[]): readonly WorkSummary[] {
	const queue = projects
		.filter((work) => work.state === "queued")
		.sort((left, right) => left.queuedSequence - right.queuedSequence);
	const queuePositions = new Map(queue.map((work, index) => [work.workId, index + 1]));
	return projects.map((work) => ({
		workId: work.workId,
		title: work.terms.title,
		state: work.state,
		stopReason: work.stopReason,
		missionState: work.missionState,
		executionState: work.execution?.state,
		hasFailure: workHasFailure(work),
		revision: work.revision,
		queuePosition: queuePositions.get(work.workId),
		budget: work.budget,
		nextAction: work.nextAction,
	}));
}

function inspectWork(projects: readonly WorkView[], workId: string): WorkView {
	const work = projects.find((candidate) => candidate.workId === workId);
	if (work === undefined) throw new Error(`Work ${workId} was not found in the Archive.`);
	return work;
}

function workHasFailure(work: WorkView): boolean {
	return [
		work.lastError !== undefined,
		work.state === "stopped" && work.stopReason === "failed",
		work.execution?.state === "failed",
	].some(Boolean);
}
