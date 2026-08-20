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
	model?: string;
	recoveryOfExecutionId?: string;
	recoveryRequestId?: string;
	failureCategory?: "model-unavailable";
	failureMessage?: string;
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

function writeExecutorRecordLocked(record: ExecutorRecord, projectTrusted: boolean, existing?: ExecutorRecord): void {
	// The locked writer accepts the record already loaded by the caller (updateExecutorRecord)
	// instead of scanning the Archive again inside this nested helper.
	const current = existing ?? readExecutorRecord(record.projectPath, record.executionId, projectTrusted);
	if (current !== undefined) {
		if (current.piSessionId !== undefined && record.piSessionId !== current.piSessionId) {
			throw new Error(`Execution ${record.executionId} has an immutable Pi session ID.`);
		}
		if (current.sessionPath !== undefined && record.sessionPath !== current.sessionPath) {
			throw new Error(`Execution ${record.executionId} has an immutable Pi session path.`);
		}
		if (
			current.promptIdentity !== undefined &&
			JSON.stringify(record.promptIdentity) !== JSON.stringify(current.promptIdentity)
		) {
			throw new Error(`Execution ${record.executionId} has an immutable prompt identity.`);
		}
		if (
			current.upstreamBase !== undefined &&
			JSON.stringify(record.upstreamBase) !== JSON.stringify(current.upstreamBase)
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
		writeExecutorRecordLocked(next, projectTrusted, current);
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
