import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { appendArchiveRecord, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import { readCurrentMission } from "./khala-archive-projections.js";
import { listExecutorRecords, updateExecutorRecord } from "./khala-executor-registry.js";
import {
	type ExecutorRecord,
	ExecutorStatus,
	isUserModelRecoveryRecord,
	type MissionRecord,
	type UserModelRecoveryRecord,
} from "./khala-model.js";

const MODEL_FAILURE_PATTERN =
	/(?:\b429\b|quota|rate[ -]?limit|usage limit|capacity|model unavailable|provider is not configured)/iu;

type PendingExecutorModelRecovery = Readonly<{
	execution: ExecutorRecord;
	mission: MissionRecord;
}>;

function isModelUnavailableError(value: unknown): boolean {
	let message = String(value);
	if (value instanceof Error) {
		const { message: errorMessage } = value;
		message = errorMessage;
	}
	return MODEL_FAILURE_PATTERN.test(message);
}

function listPendingExecutorModelRecoveries(
	projectPath: string,
	projectTrusted = false,
): readonly PendingExecutorModelRecovery[] {
	const latestByMission = new Map<string, ExecutorRecord>();
	for (const execution of listExecutorRecords(projectPath, projectTrusted)) {
		const { purpose } = execution;
		if (execution.kind !== "observer" && purpose?.kind === "mission") {
			latestByMission.set(purpose.missionId, execution);
		}
	}
	for (const [missionId, execution] of latestByMission) {
		if (execution.status !== ExecutorStatus.failed || execution.failureCategory !== "model-unavailable") {
			latestByMission.delete(missionId);
		}
	}
	const pending: PendingExecutorModelRecovery[] = [];
	for (const execution of latestByMission.values()) {
		const { purpose } = execution;
		const current = readCurrentMission(projectPath, execution.workId, projectTrusted);
		if (
			purpose?.kind === "mission" &&
			current?.state === "current" &&
			current.mission.missionId === purpose.missionId
		) {
			pending.push({ execution, mission: current.mission });
		}
	}
	return pending;
}

async function listAvailableExecutorModelIds(): Promise<readonly string[]> {
	const runtime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
		allowModelNetwork: false,
	});
	const models = await runtime.getAvailable();
	return [...new Set(models.map((model) => `${model.provider}/${model.id}`))].sort();
}

function selectedUserExecutorModelRecovery(input: {
	projectPath: string;
	workId: string;
	missionId: string;
	predecessorExecutionId: string;
	projectTrusted?: boolean;
}): UserModelRecoveryRecord | undefined {
	const record = latestUserModelRecovery(input);
	if (record?.status === "selected") {
		return record;
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy strict return analysis for no selected model.
	return undefined;
}

function latestUserModelRecovery(input: {
	projectPath: string;
	workId: string;
	missionId: string;
	predecessorExecutionId: string;
	projectTrusted?: boolean;
}): UserModelRecoveryRecord | undefined {
	const { projectPath, workId, missionId, predecessorExecutionId, projectTrusted = false } = input;
	let latest: UserModelRecoveryRecord | undefined;
	for (const record of listArchiveRecords(projectPath, projectTrusted)) {
		if (
			record.type === "user-model-recovery" &&
			isUserModelRecoveryRecord(record.payload) &&
			record.payload.role === "executor" &&
			record.payload.workId === workId &&
			record.payload.missionId === missionId &&
			record.payload.predecessorExecutionId === predecessorExecutionId
		) {
			latest = record.payload;
		}
	}
	return latest;
}

async function recordUserExecutorModelRecovery(input: {
	projectPath: string;
	projectTrusted?: boolean;
	pending: PendingExecutorModelRecovery;
	model: string;
}): Promise<UserModelRecoveryRecord> {
	const projectTrusted = input.projectTrusted ?? false;
	const model = input.model.trim();
	if (model.length === 0) {
		throw new Error("An Executor model recovery requires a non-empty model.");
	}
	const available = await listAvailableExecutorModelIds();
	if (!available.includes(model)) {
		throw new Error(`Executor model is not available: ${model}`);
	}
	return withArchiveLock(input.projectPath, projectTrusted, () => {
		const existing = latestUserModelRecovery({
			projectPath: input.projectPath,
			workId: input.pending.execution.workId,
			missionId: input.pending.mission.missionId,
			predecessorExecutionId: input.pending.execution.executionId,
			projectTrusted,
		});
		if (existing?.status === "selected" && existing.model === model) {
			return existing;
		}
		const record: UserModelRecoveryRecord = {
			requestId: nanoid(),
			role: "executor",
			model,
			workId: input.pending.execution.workId,
			missionId: input.pending.mission.missionId,
			predecessorExecutionId: input.pending.execution.executionId,
			status: "selected",
			requestedAt: new Date().toISOString(),
		};
		appendArchiveRecord(
			input.projectPath,
			{ schemaVersion: 2, type: "user-model-recovery", workId: record.workId, payload: record },
			projectTrusted,
		);
		updateExecutorRecord(
			input.projectPath,
			input.pending.execution.executionId,
			{ recoveryRequestId: record.requestId },
			projectTrusted,
		);
		return record;
	});
}

function markUserExecutorModelRecoveryApplied(
	projectPath: string,
	request: UserModelRecoveryRecord,
	replacementExecutionId: string,
	projectTrusted = false,
): void {
	if (request.status !== "selected") {
		return;
	}
	const applied: UserModelRecoveryRecord = {
		...request,
		status: "applied",
		replacementExecutionId,
		appliedAt: new Date().toISOString(),
	};
	appendArchiveRecord(
		projectPath,
		{ schemaVersion: 2, type: "user-model-recovery", workId: request.workId, payload: applied },
		projectTrusted,
	);
}

export type { PendingExecutorModelRecovery };
export {
	isModelUnavailableError,
	latestUserModelRecovery,
	listAvailableExecutorModelIds,
	listPendingExecutorModelRecoveries,
	markUserExecutorModelRecoveryApplied,
	recordUserExecutorModelRecovery,
	selectedUserExecutorModelRecovery,
};
