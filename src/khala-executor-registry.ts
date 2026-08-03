import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import { listExecutionRecords } from "./khala-archive-projections.js";
import {
	type ExecutorPromptIdentity,
	type ExecutorRecord,
	ExecutorStatus,
	type ExecutorStatusValue,
	type UpstreamExecutionBase,
} from "./khala-model.js";

type ExecutorRuntimeUpdate = Readonly<{
	status?: ExecutorStatusValue;
	target?: string;
	sandboxPath?: string;
	launcher?: string;
	piSessionId?: string;
	sessionPath?: string;
	promptIdentity?: ExecutorPromptIdentity;
	upstreamBase?: UpstreamExecutionBase;
	lastSignalAt?: string;
}>;

function createExecutorRecord(
	record: Omit<ExecutorRecord, "status" | "startedAt">,
	initialStatus: ExecutorStatusValue = ExecutorStatus.running,
): ExecutorRecord {
	return { ...record, status: initialStatus, startedAt: new Date().toISOString() };
}

function writeExecutorRecord(record: ExecutorRecord, projectTrusted = false): void {
	withArchiveLock(record.projectPath, projectTrusted, () => writeExecutorRecordLocked(record, projectTrusted));
}

function writeExecutorRecordLocked(record: ExecutorRecord, projectTrusted: boolean): void {
	const existing = readExecutorRecord(record.projectPath, record.executionId, projectTrusted);
	if (existing !== undefined) {
		if (existing.piSessionId !== undefined && record.piSessionId !== existing.piSessionId) {
			throw new Error(`Execution ${record.executionId} has an immutable Pi session ID.`);
		}
		if (existing.sessionPath !== undefined && record.sessionPath !== existing.sessionPath) {
			throw new Error(`Execution ${record.executionId} has an immutable Pi session path.`);
		}
		if (
			existing.promptIdentity !== undefined &&
			JSON.stringify(record.promptIdentity) !== JSON.stringify(existing.promptIdentity)
		) {
			throw new Error(`Execution ${record.executionId} has an immutable prompt identity.`);
		}
		if (
			existing.upstreamBase !== undefined &&
			JSON.stringify(record.upstreamBase) !== JSON.stringify(existing.upstreamBase)
		) {
			throw new Error(`Execution ${record.executionId} has an immutable upstream base.`);
		}
	}
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
		if (
			(update.piSessionId !== undefined &&
				current.piSessionId !== undefined &&
				update.piSessionId !== current.piSessionId) ||
			(update.sessionPath !== undefined &&
				current.sessionPath !== undefined &&
				update.sessionPath !== current.sessionPath) ||
			(update.promptIdentity !== undefined &&
				current.promptIdentity !== undefined &&
				JSON.stringify(update.promptIdentity) !== JSON.stringify(current.promptIdentity)) ||
			(update.upstreamBase !== undefined &&
				current.upstreamBase !== undefined &&
				JSON.stringify(update.upstreamBase) !== JSON.stringify(current.upstreamBase))
		) {
			throw new Error(`Execution ${executionId} has immutable identity bindings.`);
		}
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
