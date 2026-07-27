import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import { listExecutionRecords } from "./khala-archive-projections.js";
import { type ExecutorRecord, ExecutorStatus, type ExecutorStatusValue } from "./khala-model.js";

type ExecutorRuntimeUpdate = Readonly<{
	status?: ExecutorStatusValue;
	target?: string;
	sandboxPath?: string;
	launcher?: string;
	sessionPath?: string;
	lastSignalAt?: string;
}>;

function createExecutorRecord(
	record: Omit<ExecutorRecord, "status" | "startedAt">,
	initialStatus: ExecutorStatusValue = ExecutorStatus.running,
): ExecutorRecord {
	return { ...record, status: initialStatus, startedAt: new Date().toISOString() };
}

function writeExecutorRecord(record: ExecutorRecord, projectTrusted = false): void {
	appendArchiveRecord(
		record.projectPath,
		{
			type: "execution",
			workId: record.workId,
			executionId: record.executionId,
			payload: record,
		},
		projectTrusted,
	);
}

function updateExecutorRecord(
	projectPath: string,
	executionId: string,
	update: ExecutorRuntimeUpdate,
	projectTrusted = false,
): ExecutorRecord | undefined {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const current = readExecutorRecord(projectPath, executionId, projectTrusted);
		if (current === undefined) {
			return;
		}
		const next = { ...current, ...update };
		writeExecutorRecord(next, projectTrusted);
		return next;
	});
}

function readExecutorRecord(
	projectPath: string,
	executionId: string,
	projectTrusted = false,
): ExecutorRecord | undefined {
	let latest: ExecutorRecord | undefined;
	for (const record of listExecutionRecords(projectPath, projectTrusted)) {
		if (record.executionId === executionId) {
			latest = record;
		}
	}
	return latest;
}

function listExecutorRecords(projectPath: string, projectTrusted = false): ExecutorRecord[] {
	const latest = new Map<string, ExecutorRecord>();
	for (const execution of listExecutionRecords(projectPath, projectTrusted)) {
		latest.set(execution.executionId, execution);
	}
	return [...latest.values()];
}

export type { ExecutorRuntimeUpdate };
export { createExecutorRecord, listExecutorRecords, readExecutorRecord, updateExecutorRecord, writeExecutorRecord };
