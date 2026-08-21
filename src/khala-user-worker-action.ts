// biome-ignore-all lint/style/noTernary: Optional Archive fields are assembled explicitly at this persistence boundary.
// biome-ignore-all lint/style/noContinue: Archive scans use bounded early skips for unrelated records.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Durable worker action persistence and execution share one narrow interface.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Worker action preconditions fail closed at one authoritative seam.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Each action keeps its Archive and runtime fence together.
// biome-ignore-all lint/complexity/useMaxParams: Result helpers preserve explicit lifecycle identity fields.
// biome-ignore-all lint/suspicious/useAwait: Async action dispatch keeps one uniform coordinator contract.
import { createHash } from "node:crypto";
import type { HeadlessExecutorRuntime } from "./executor-rpc.js";
import { appendArchiveRecord, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	activeCoordinationHolds,
	listSignalRecords,
	listVerdictRecords,
	listWorkOutcomeRecords,
	readCurrentMission,
} from "./khala-archive-projections.js";
import { readExecutorRecord } from "./khala-executor-registry.js";
import {
	type AttentionDismissalRecord,
	type ExecutorRecord,
	ExecutorStatus,
	isAttentionDismissalRecord,
	isExecutorRecord,
	isMissionExecutorRecord,
	isUserWorkerActionRecord,
	type KhalaArchiveRecord,
	type MissionRecord,
	type UserWorkerActionKind,
	type UserWorkerActionOutcome,
	type UserWorkerActionRequest,
} from "./khala-model.js";
import { mandatoryStopExecution } from "./khala-supervision-recovery.js";

type UserWorkerActionState = Readonly<{
	request: UserWorkerActionRequest;
	requestRecordId: string;
	outcome?: UserWorkerActionOutcome;
	created: boolean;
}>;

type SameMissionRecoveryResult =
	| Readonly<{ status: "started"; missionId: string; executionId: string; predecessorExecutionId: string }>
	| Readonly<{ status: "already-active"; missionId: string; executionId: string }>
	| Readonly<{ status: "held"; missionId: string; reason: string }>
	| Readonly<{ status: "stale"; reason: string }>
	| Readonly<{ status: "not-allowed"; reason: string }>
	| Readonly<{
			status: "launch-failed";
			missionId: string;
			executionId: string;
			predecessorExecutionId: string;
			reason: string;
	  }>;

type ExecutionRuntimeState = Awaited<ReturnType<HeadlessExecutorRuntime["probeRuntime"]>>;
type WorkerActionServices = Readonly<{
	getRuntime: (executionId: string) => Promise<HeadlessExecutorRuntime | undefined>;
	continueMission: (input: {
		failedExecution: ExecutorRecord;
		mission: MissionRecord;
		model?: string;
	}) => Promise<SameMissionRecoveryResult>;
	failExecution: (executionId: string) => Promise<void>;
}>;
type WorkerActionResult =
	| Readonly<{
			status: "sent" | "already-sent";
			actionId: string;
			missionId: string;
			executionId: string;
	  }>
	| Readonly<{
			status: "busy" | "unreachable" | "unknown" | "stale" | "not-allowed" | "delivery-unknown";
			actionId: string;
			missionId?: string;
			executionId?: string;
			reason: string;
	  }>
	| Readonly<{
			status: "started" | "already-active";
			actionId: string;
			missionId: string;
			executionId: string;
			predecessorExecutionId?: string;
	  }>
	| Readonly<{
			status: "held" | "launch-failed";
			actionId: string;
			missionId: string;
			executionId?: string;
			predecessorExecutionId?: string;
			reason: string;
	  }>
	| Readonly<{
			status: "asked" | "already-asked";
			actionId: string;
			missionId: string;
			executionId: string;
	  }>;

type UserWorkerActionResult = WorkerActionResult;
type ExecuteUserWorkerActionInput = UserWorkerActionRequestInput &
	Readonly<{
		projectPath: string;
		projectTrusted: boolean;
		services: WorkerActionServices;
	}>;

type UserWorkerActionRequestInput = Readonly<{
	actionId: string;
	kind: UserWorkerActionKind;
	conditionId: string;
	workId: string;
	expectedMissionId: string;
	expectedExecutionId?: string;
	model?: string;
	requestedAt?: string;
}>;

type UserWorkerActionOutcomeInput = Readonly<{
	actionId: string;
	status: UserWorkerActionOutcome["status"];
	missionId?: string;
	executionId?: string;
	predecessorExecutionId?: string;
	reason?: string;
	recordedAt?: string;
}>;

type AttentionDismissalInput = Readonly<{
	conditionId: string;
	workId?: string;
	kind: string;
	dismissedAt?: string;
}>;

function userWorkerActionId(conditionId: string, kind: UserWorkerActionKind, model?: string): string {
	const modelKey = model === undefined ? "" : model;
	return `worker-action-${sha256(`${conditionId}\u0000${kind}\u0000${modelKey}`)}`;
}

function readUserWorkerAction(
	projectPath: string,
	actionId: string,
	projectTrusted = false,
): UserWorkerActionState | undefined {
	let request: UserWorkerActionRequest | undefined;
	let requestRecordId: string | undefined;
	let outcome: UserWorkerActionOutcome | undefined;
	for (const record of listArchiveRecords(projectPath, projectTrusted)) {
		if (record.type !== "user-worker-action" || !isUserWorkerActionRecord(record.payload)) {
			continue;
		}
		if (record.payload.actionId !== actionId) {
			continue;
		}
		if (record.payload.phase === "request") {
			request = record.payload;
			requestRecordId = record.recordId;
		} else {
			outcome = record.payload;
		}
	}
	if (request === undefined || requestRecordId === undefined) {
		return;
	}
	if (outcome === undefined) {
		return { request, requestRecordId, created: false };
	}
	return { request, requestRecordId, outcome, created: false };
}

function appendUserWorkerActionRequest(
	projectPath: string,
	input: UserWorkerActionRequestInput,
	projectTrusted = false,
): UserWorkerActionState {
	const actionId = input.actionId.trim();
	if (actionId.length === 0) {
		throw new Error("A User Worker action requires a non-empty action ID.");
	}
	return withArchiveLock(projectPath, projectTrusted, () => {
		const existing = readUserWorkerAction(projectPath, actionId, projectTrusted);
		const requestedAt = input.requestedAt ?? existing?.request.requestedAt ?? new Date().toISOString();
		const request: UserWorkerActionRequest = {
			phase: "request",
			actionId,
			kind: input.kind,
			conditionId: input.conditionId,
			workId: input.workId,
			expectedMissionId: input.expectedMissionId,
			...(input.expectedExecutionId === undefined ? {} : { expectedExecutionId: input.expectedExecutionId }),
			...(input.model === undefined ? {} : { model: input.model }),
			requestedAt,
		};
		if (existing !== undefined) {
			if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
				throw new Error(`User Worker action ${actionId} has conflicting request evidence.`);
			}
			return existing;
		}
		const record = appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "user-worker-action", workId: input.workId, payload: request },
			projectTrusted,
		);
		return { request, requestRecordId: record.recordId, created: true };
	});
}

function appendUserWorkerActionOutcome(
	projectPath: string,
	input: UserWorkerActionOutcomeInput,
	projectTrusted = false,
): UserWorkerActionState {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const existing = readUserWorkerAction(projectPath, input.actionId, projectTrusted);
		if (existing === undefined) {
			throw new Error(`User Worker action ${input.actionId} has no persisted request.`);
		}
		if (existing.outcome !== undefined) {
			return existing;
		}
		const outcome: UserWorkerActionOutcome = {
			phase: "outcome",
			actionId: input.actionId,
			kind: existing.request.kind,
			conditionId: existing.request.conditionId,
			workId: existing.request.workId,
			requestRecordId: existing.requestRecordId,
			status: input.status,
			...(input.missionId === undefined ? {} : { missionId: input.missionId }),
			...(input.executionId === undefined ? {} : { executionId: input.executionId }),
			...(input.predecessorExecutionId === undefined ? {} : { predecessorExecutionId: input.predecessorExecutionId }),
			...(input.reason === undefined ? {} : { reason: input.reason }),
			recordedAt: input.recordedAt ?? new Date().toISOString(),
		};
		const append: {
			schemaVersion: 2;
			type: "user-worker-action";
			workId: string;
			executionId?: string;
			payload: UserWorkerActionOutcome;
		} = {
			schemaVersion: 2,
			type: "user-worker-action",
			workId: existing.request.workId,
			payload: outcome,
		};
		if (outcome.executionId !== undefined) {
			append.executionId = outcome.executionId;
		}
		appendArchiveRecord(projectPath, append, projectTrusted);
		return { ...existing, outcome };
	});
}

function appendAttentionDismissal(
	projectPath: string,
	input: AttentionDismissalInput,
	projectTrusted = false,
): AttentionDismissalRecord {
	const dismissalId = `dismissal-${sha256(`${input.conditionId}\u0000${input.workId ?? ""}`)}`;
	return withArchiveLock(projectPath, projectTrusted, () => {
		for (const record of listArchiveRecords(projectPath, projectTrusted)) {
			if (
				record.type === "attention-dismissal" &&
				isAttentionDismissalRecord(record.payload) &&
				record.payload.dismissalId === dismissalId
			) {
				if (
					record.payload.conditionId !== input.conditionId ||
					record.payload.workId !== input.workId ||
					record.payload.kind !== input.kind
				) {
					throw new Error(`Attention dismissal ${dismissalId} has conflicting evidence.`);
				}
				return record.payload;
			}
		}
		const dismissal: AttentionDismissalRecord = {
			dismissalId,
			conditionId: input.conditionId,
			...(input.workId === undefined ? {} : { workId: input.workId }),
			kind: input.kind,
			dismissedAt: input.dismissedAt ?? new Date().toISOString(),
		};
		appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "attention-dismissal", workId: input.workId ?? "project", payload: dismissal },
			projectTrusted,
		);
		return dismissal;
	});
}

function dismissedConditionIds(records: readonly KhalaArchiveRecord[]): ReadonlySet<string> {
	const dismissed = new Set<string>();
	for (const record of records) {
		if (record.type === "attention-dismissal" && isAttentionDismissalRecord(record.payload)) {
			dismissed.add(record.payload.conditionId);
		}
	}
	return dismissed;
}

function executeUserWorkerAction(input: ExecuteUserWorkerActionInput): Promise<WorkerActionResult> {
	const state = appendUserWorkerActionRequest(input.projectPath, input, input.projectTrusted);
	if (state.outcome !== undefined) {
		return Promise.resolve(replayWorkerActionOutcome(state.request, state.outcome));
	}
	if (!state.created) {
		const reason = "A previous attempt for this action has no durable outcome; it will not be sent again.";
		const outcome = appendUserWorkerActionOutcome(
			input.projectPath,
			{ actionId: state.request.actionId, status: "failed", reason },
			input.projectTrusted,
		);
		return Promise.resolve(replayWorkerActionOutcome(state.request, outcome.outcome as UserWorkerActionOutcome));
	}
	return executeNewUserWorkerAction(input, state.request).catch((error: unknown) => {
		const outcome = appendUserWorkerActionOutcome(
			input.projectPath,
			{
				actionId: state.request.actionId,
				status: "failed",
				reason: `The User Worker action failed before its result was durable: ${errorMessage(error)}`,
			},
			input.projectTrusted,
		);
		return replayWorkerActionOutcome(state.request, outcome.outcome as UserWorkerActionOutcome);
	});
}

async function executeNewUserWorkerAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
): Promise<WorkerActionResult> {
	if (request.kind === "try-current-execution") {
		return executeTryCurrentExecution(input, request);
	}
	if (request.kind === "continue-current-mission") {
		return executeContinueCurrentMission(input, request);
	}
	return executeStopCurrentExecution(input, request);
}

async function executeTryCurrentExecution(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
): Promise<WorkerActionResult> {
	const current = currentMissionForAction(input, request);
	if (current === undefined) {
		return rejectWorkerAction(input, request, "The expected Mission is no longer current.");
	}
	if (request.expectedExecutionId === undefined) {
		return rejectWorkerAction(
			input,
			request,
			"Trying the current worker requires an expected Execution.",
			current.mission.missionId,
		);
	}
	const execution = readExecutorRecord(input.projectPath, request.expectedExecutionId, input.projectTrusted);
	if (
		execution === undefined ||
		!isMissionExecutorRecord(execution) ||
		execution.workId !== request.workId ||
		execution.missionId !== current.mission.missionId
	) {
		return rejectWorkerAction(
			input,
			request,
			"The expected Execution does not belong to the current Mission.",
			current.mission.missionId,
		);
	}
	if (execution.status !== ExecutorStatus.running) {
		return rejectWorkerAction(
			input,
			request,
			"The current Execution is not running.",
			current.mission.missionId,
			execution.executionId,
		);
	}
	if (blockedAwaitingVerdict(input, execution)) {
		return rejectWorkerAction(
			input,
			request,
			"The current Execution is blocked and awaits an authoritative Conclave Verdict.",
			current.mission.missionId,
			execution.executionId,
		);
	}
	const runtime = await input.services.getRuntime(execution.executionId);
	if (runtime === undefined) {
		return runtimeUnavailableResult(input, request, current.mission.missionId, execution.executionId);
	}
	const runtimeState = await runtime.probeRuntime();
	if (runtimeState.kind !== "idle") {
		return runtimeObservationResult(input, request, current.mission.missionId, execution.executionId, runtimeState);
	}
	const marker = `\\u0000KHALA_WORK_ACTION:${request.actionId}:`;
	const continuation = `${marker}\nContinue the current immutable Mission from the persisted session and worktree. Re-read the Mission terms and latest durable evidence, inspect the current changes, validate the work, and emit the next appropriate Signal. Do not create or assume a successor Mission.`;
	try {
		await runtime.sendPrompt(continuation);
		const entries = await runtime.getEntries();
		if (!entries.entries.some((entry) => entryContainsMarker(entry, marker))) {
			return failWorkerAction(
				input,
				request,
				"The continuation request was accepted but its persisted Pi entry could not be confirmed.",
				current.mission.missionId,
				execution.executionId,
			);
		}
		appendUserWorkerActionOutcome(
			input.projectPath,
			{
				actionId: request.actionId,
				status: "applied",
				missionId: current.mission.missionId,
				executionId: execution.executionId,
			},
			input.projectTrusted,
		);
		return {
			status: "sent",
			actionId: request.actionId,
			missionId: current.mission.missionId,
			executionId: execution.executionId,
		};
	} catch (error) {
		return failWorkerAction(
			input,
			request,
			`The continuation request could not be confirmed: ${errorMessage(error)}`,
			current.mission.missionId,
			execution.executionId,
		);
	}
}

async function executeContinueCurrentMission(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
): Promise<WorkerActionResult> {
	const current = currentMissionForAction(input, request);
	if (current === undefined) {
		return rejectWorkerAction(input, request, "The expected Mission is no longer current.");
	}
	if (
		listWorkOutcomeRecords(input.projectPath, input.projectTrusted).some((outcome) => outcome.workId === request.workId)
	) {
		return rejectWorkerAction(input, request, "The Work already has an accepted Outcome.", current.mission.missionId);
	}
	const hold = activeCoordinationHolds(input.projectPath, input.projectTrusted).find(
		(candidate) => candidate.workId === request.workId && candidate.missionId === current.mission.missionId,
	);
	if (hold !== undefined) {
		return rejectWorkerAction(
			input,
			request,
			hold.coordination.latest.reason,
			current.mission.missionId,
			undefined,
			"rejected",
			"held",
		);
	}
	const active = latestMissionExecutions(input.projectPath, input.projectTrusted).find(
		(execution) =>
			execution.missionId === current.mission.missionId &&
			(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
	);
	if (active !== undefined) {
		if (blockedAwaitingVerdict(input, active)) {
			return rejectWorkerAction(
				input,
				request,
				"The current Execution is blocked and awaits an authoritative Conclave Verdict.",
				current.mission.missionId,
				active.executionId,
			);
		}
		return completeRejectedWorkerAction(input, request, {
			status: "already-active",
			actionId: request.actionId,
			missionId: current.mission.missionId,
			executionId: active.executionId,
		});
	}
	let predecessor = predecessorForContinue(input, request, current.mission.missionId);
	if (predecessor === undefined) {
		return rejectWorkerAction(
			input,
			request,
			"No failed current-Mission Execution is eligible for replacement.",
			current.mission.missionId,
		);
	}
	if (predecessor.status === ExecutorStatus.running) {
		const runtime = await input.services.getRuntime(predecessor.executionId);
		const runtimeState = runtime === undefined ? undefined : await runtime.probeRuntime();
		if (runtimeState !== undefined && runtimeState.kind !== "unreachable") {
			return runtimeObservationResult(input, request, current.mission.missionId, predecessor.executionId, runtimeState);
		}
		await input.services.failExecution(predecessor.executionId);
		predecessor = readExecutorRecord(input.projectPath, predecessor.executionId, input.projectTrusted);
	}
	if (predecessor === undefined || predecessor.status !== ExecutorStatus.failed) {
		return rejectWorkerAction(
			input,
			request,
			"The predecessor Execution was not durably failed.",
			current.mission.missionId,
		);
	}
	if (blockedAwaitingVerdict(input, predecessor)) {
		return rejectWorkerAction(
			input,
			request,
			"The predecessor is blocked and awaits an authoritative Conclave Verdict.",
			current.mission.missionId,
			predecessor.executionId,
		);
	}
	if (predecessor.failureCategory === "model-unavailable" && request.model === undefined) {
		return rejectWorkerAction(
			input,
			request,
			"Select an available Executor model before continuing this recovery.",
			current.mission.missionId,
			predecessor.executionId,
		);
	}
	const result = await input.services.continueMission({
		failedExecution: predecessor,
		mission: current.mission,
		...(request.model === undefined ? {} : { model: request.model }),
	});
	return completeRecoveryAction(input, request, result);
}

async function executeStopCurrentExecution(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
): Promise<WorkerActionResult> {
	const current = currentMissionForAction(input, request);
	if (current === undefined) {
		return rejectWorkerAction(input, request, "The expected Mission is no longer current.");
	}
	if (request.expectedExecutionId === undefined) {
		return rejectWorkerAction(
			input,
			request,
			"Asking a worker to stop requires an expected Execution.",
			current.mission.missionId,
		);
	}
	const execution = readExecutorRecord(input.projectPath, request.expectedExecutionId, input.projectTrusted);
	if (
		execution === undefined ||
		!isMissionExecutorRecord(execution) ||
		execution.workId !== request.workId ||
		execution.missionId !== current.mission.missionId
	) {
		return rejectWorkerAction(
			input,
			request,
			"The expected Execution does not belong to the current Mission.",
			current.mission.missionId,
		);
	}
	if (execution.status !== ExecutorStatus.running) {
		return rejectWorkerAction(
			input,
			request,
			"Only a running Execution can be asked to stop.",
			current.mission.missionId,
			execution.executionId,
		);
	}
	const runtime = await input.services.getRuntime(execution.executionId);
	if (runtime === undefined) {
		return runtimeUnavailableResult(input, request, current.mission.missionId, execution.executionId);
	}
	const runtimeState = await runtime.probeRuntime();
	if (runtimeState.kind === "unreachable" || runtimeState.kind === "unknown") {
		return runtimeObservationResult(input, request, current.mission.missionId, execution.executionId, runtimeState);
	}
	const marker = `\\u0000KHALA_WORK_ACTION_STOP:${request.actionId}:`;
	try {
		await mandatoryStopExecution(runtime, {
			marker,
			message:
				"The User asked this worker to stop. Do not modify, create, delete, or stage files. Submit exactly one current blocked khala_signal with nonempty evidence.",
			getBaselineSignalIds: () =>
				listSignalRecords(input.projectPath, input.projectTrusted).map((signal) => signal.signalId),
			validatePostSettlement: (baselineSignalIds) => {
				const baseline = new Set(baselineSignalIds);
				const signals = listSignalRecords(input.projectPath, input.projectTrusted).filter(
					(signal) =>
						signal.workId === request.workId &&
						signal.missionId === current.mission.missionId &&
						signal.executionId === execution.executionId &&
						!baseline.has(signal.signalId) &&
						signal.kind === "blocked" &&
						signal.evidence.length > 0,
				);
				return Promise.resolve(signals.length === 1);
			},
		});
	} catch (error) {
		return failWorkerAction(
			input,
			request,
			`The stop handoff could not be confirmed: ${errorMessage(error)}`,
			current.mission.missionId,
			execution.executionId,
		);
	}
	appendUserWorkerActionOutcome(
		input.projectPath,
		{
			actionId: request.actionId,
			status: "applied",
			missionId: current.mission.missionId,
			executionId: execution.executionId,
		},
		input.projectTrusted,
	);
	return {
		status: "asked",
		actionId: request.actionId,
		missionId: current.mission.missionId,
		executionId: execution.executionId,
	};
}

function currentMissionForAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
): ReturnType<typeof readCurrentMission> {
	const current = readCurrentMission(input.projectPath, request.workId, input.projectTrusted);
	if (current?.state !== "current" || current.mission.missionId !== request.expectedMissionId) {
		return;
	}
	return current;
}

function latestMissionExecutions(projectPath: string, projectTrusted: boolean): ExecutorRecord[] {
	const latest = new Map<string, ExecutorRecord>();
	for (const record of listArchiveRecords(projectPath, projectTrusted)) {
		if (record.type === "execution" && isExecutorRecord(record.payload)) {
			latest.set(record.payload.executionId, record.payload);
		}
	}
	return [...latest.values()];
}

function predecessorForContinue(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	missionId: string,
): ExecutorRecord | undefined {
	const executions = latestMissionExecutions(input.projectPath, input.projectTrusted).filter(
		(execution) => isMissionExecutorRecord(execution) && execution.missionId === missionId,
	);
	if (request.expectedExecutionId !== undefined) {
		return executions.find((execution) => execution.executionId === request.expectedExecutionId);
	}
	return executions.at(-1);
}

function blockedAwaitingVerdict(input: ExecuteUserWorkerActionInput, execution: ExecutorRecord): boolean {
	const latestSignal = listSignalRecords(input.projectPath, input.projectTrusted)
		.filter((signal) => signal.executionId === execution.executionId)
		.at(-1);
	if (latestSignal?.kind !== "blocked") {
		return false;
	}
	return !listVerdictRecords(input.projectPath, input.projectTrusted).some(
		(verdict) => verdict.executionId === execution.executionId && verdict.signalId === latestSignal.signalId,
	);
}

function entryContainsMarker(entry: Readonly<{ message?: unknown }>, marker: string): boolean {
	if (typeof entry.message !== "object" || entry.message === null) {
		return false;
	}
	const message = entry.message as { role?: unknown; content?: unknown };
	if (message.role !== "user") {
		return false;
	}
	if (typeof message.content === "string") {
		return message.content.includes(marker);
	}
	if (!Array.isArray(message.content)) {
		return false;
	}
	return message.content.some(
		(part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(marker),
	);
}

function runtimeUnavailableResult(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	missionId: string,
	executionId: string,
): WorkerActionResult {
	return rejectWorkerAction(
		input,
		request,
		"The supervised runtime could not be reached.",
		missionId,
		executionId,
		"rejected",
		"unreachable",
	);
}

function runtimeObservationResult(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	missionId: string,
	executionId: string,
	runtime: ExecutionRuntimeState,
): WorkerActionResult {
	if (runtime.kind === "busy") {
		return rejectWorkerAction(
			input,
			request,
			"The current worker is busy with an active turn.",
			missionId,
			executionId,
			"rejected",
			"busy",
		);
	}
	if (runtime.kind === "unreachable") {
		return rejectWorkerAction(input, request, runtime.reason, missionId, executionId, "rejected", "unreachable");
	}
	if (runtime.kind === "unknown") {
		return rejectWorkerAction(input, request, runtime.reason, missionId, executionId, "rejected", "unknown");
	}
	return rejectWorkerAction(input, request, "The runtime is not idle.", missionId, executionId, "rejected", "unknown");
}

function rejectWorkerAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	reason: string,
	missionId?: string,
	executionId?: string,
	outcomeStatus: "rejected" | "failed" = "rejected",
	resultStatus: WorkerActionResult["status"] = "not-allowed",
): WorkerActionResult {
	const result = {
		status: resultStatus,
		actionId: request.actionId,
		...(missionId === undefined ? {} : { missionId }),
		...(executionId === undefined ? {} : { executionId }),
		reason,
	} as WorkerActionResult;
	appendUserWorkerActionOutcome(
		input.projectPath,
		{
			actionId: request.actionId,
			status: outcomeStatus,
			...(missionId === undefined ? {} : { missionId }),
			...(executionId === undefined ? {} : { executionId }),
			reason,
		},
		input.projectTrusted,
	);
	return result;
}

function completeRejectedWorkerAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	result: WorkerActionResult,
): WorkerActionResult {
	appendUserWorkerActionOutcome(
		input.projectPath,
		{
			actionId: request.actionId,
			status: "rejected",
			...(result.missionId === undefined ? {} : { missionId: result.missionId }),
			...(result.executionId === undefined ? {} : { executionId: result.executionId }),
			reason: result.status,
		},
		input.projectTrusted,
	);
	return result;
}

function failWorkerAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	reason: string,
	missionId?: string,
	executionId?: string,
): WorkerActionResult {
	return rejectWorkerAction(input, request, reason, missionId, executionId, "failed", "delivery-unknown");
}

function completeRecoveryAction(
	input: ExecuteUserWorkerActionInput,
	request: UserWorkerActionRequest,
	result: SameMissionRecoveryResult,
): WorkerActionResult {
	if (result.status === "started") {
		appendUserWorkerActionOutcome(
			input.projectPath,
			{
				actionId: request.actionId,
				status: "applied",
				missionId: result.missionId,
				executionId: result.executionId,
				predecessorExecutionId: result.predecessorExecutionId,
			},
			input.projectTrusted,
		);
		return { ...result, actionId: request.actionId };
	}
	if (result.status === "already-active") {
		return completeRejectedWorkerAction(input, request, { ...result, actionId: request.actionId });
	}
	if (result.status === "launch-failed") {
		appendUserWorkerActionOutcome(
			input.projectPath,
			{
				actionId: request.actionId,
				status: "failed",
				missionId: result.missionId,
				executionId: result.executionId,
				predecessorExecutionId: result.predecessorExecutionId,
				reason: result.reason,
			},
			input.projectTrusted,
		);
		return { ...result, actionId: request.actionId };
	}
	return rejectWorkerAction(
		input,
		request,
		result.reason,
		result.status === "stale" || result.status === "not-allowed" ? undefined : result.missionId,
		undefined,
		"rejected",
		result.status,
	);
}

function replayWorkerActionOutcome(
	request: UserWorkerActionRequest,
	outcome: UserWorkerActionOutcome,
): WorkerActionResult {
	if (request.kind === "try-current-execution") {
		if (outcome.status === "applied") {
			return {
				status: "already-sent",
				actionId: request.actionId,
				missionId: outcome.missionId ?? request.expectedMissionId,
				executionId: outcome.executionId ?? request.expectedExecutionId ?? "unknown-execution",
			};
		}
		return {
			status: outcome.status === "failed" ? "delivery-unknown" : "not-allowed",
			actionId: request.actionId,
			reason: outcome.reason ?? "The User Worker action was not applied.",
		};
	}
	if (request.kind === "stop-current-execution") {
		if (outcome.status === "applied") {
			return {
				status: "already-asked",
				actionId: request.actionId,
				missionId: outcome.missionId ?? request.expectedMissionId,
				executionId: outcome.executionId ?? request.expectedExecutionId ?? "unknown-execution",
			};
		}
		return {
			status: outcome.status === "failed" ? "delivery-unknown" : "not-allowed",
			actionId: request.actionId,
			reason: outcome.reason ?? "The User Worker action was not applied.",
		};
	}
	if (outcome.status === "applied") {
		return {
			status: "already-active",
			actionId: request.actionId,
			missionId: outcome.missionId ?? request.expectedMissionId,
			executionId: outcome.executionId ?? "unknown-execution",
		};
	}
	return {
		status: outcome.status === "failed" ? "launch-failed" : "not-allowed",
		actionId: request.actionId,
		missionId: request.expectedMissionId,
		reason: outcome.reason ?? "The User Worker action was not applied.",
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export type {
	AttentionDismissalInput,
	ExecuteUserWorkerActionInput,
	SameMissionRecoveryResult,
	UserWorkerActionOutcomeInput,
	UserWorkerActionRequestInput,
	UserWorkerActionResult,
	UserWorkerActionState,
	WorkerActionResult,
};
export {
	appendAttentionDismissal,
	appendUserWorkerActionOutcome,
	appendUserWorkerActionRequest,
	dismissedConditionIds,
	executeUserWorkerAction,
	readUserWorkerAction,
	userWorkerActionId,
};
