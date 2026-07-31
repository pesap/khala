// biome-ignore-all lint/style/noExcessiveLinesPerFile: Verdict persistence keeps validation, retry, and terminal transaction logic together.
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { appendArchiveRecord, appendArchiveRecords, withArchiveLock } from "./khala-archive.js";
import { type MissionProjection, readCurrentMission, readMandate } from "./khala-archive-projections.js";
import { readExecutorRecord, updateExecutorRecord, writeExecutorRecord } from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	type ExecutorStatusValue,
	type KhalaWork,
	type MissionRecord,
	type RetryHandoff,
	type VerdictRecord,
} from "./khala-model.js";
import { markPullRequestReviewable } from "./khala-review.js";
import type { readSignal } from "./khala-signal.js";
import type { NormalizedVerdictInput, RequeueSubmission, VerdictInput } from "./khala-verdict.js";

const PARTICIPANT_HASH_LENGTH = 16;

function processNewVerdict(input: {
	params: VerdictInput;
	context: ExtensionContext;
	signal: NonNullable<ReturnType<typeof readSignal>>;
	projectTrusted: boolean;
	requeueSubmission: RequeueSubmission;
	normalizedParams: NormalizedVerdictInput;
	reason: string;
}) {
	const { params, context, signal, projectTrusted, requeueSubmission, normalizedParams, reason } = input;
	const execution = readExecutorRecord(context.cwd, params.executionId, projectTrusted);
	if (execution === undefined || execution.status !== ExecutorStatus.running || execution.workId !== params.workId) {
		throw new Error("A Verdict may only be issued for a current running Executor execution.");
	}

	const missionContext = validateMissionVerdict({
		execution,
		signal,
		params,
		projectPath: context.cwd,
		projectTrusted,
		normalizedAssignment: normalizedParams.successorAssignment,
		normalizedRetryHandoff: normalizedParams.retryHandoff,
	});
	const { missionId, missionProjection } = missionContext;
	const verdict = createVerdictRecord({
		params,
		reason,
		missionId,
		missionProjection,
		normalizedAssignment: normalizedParams.successorAssignment,
		normalizedRetryHandoff: normalizedParams.retryHandoff,
		projectPath: context.cwd,
	});

	return persistVerdict({
		verdict,
		missionId,
		missionProjection,
		context,
		projectTrusted,
		requeueSubmission,
	});
}

type MissionVerdictContext = Readonly<{
	missionId?: string;
	missionProjection?: MissionProjection;
}>;

function validateMissionVerdict(input: {
	execution: NonNullable<ReturnType<typeof readExecutorRecord>>;
	signal: NonNullable<ReturnType<typeof readSignal>>;
	params: VerdictInput;
	projectPath: string;
	projectTrusted: boolean;
	normalizedAssignment: KhalaWork | undefined;
	normalizedRetryHandoff: RetryHandoff | undefined;
}): MissionVerdictContext {
	if (input.execution.purpose?.kind !== "mission") {
		return {};
	}
	const { missionId } = input.execution.purpose;
	const missionProjection = readCurrentMission(input.projectPath, input.params.workId, input.projectTrusted);
	if (
		missionProjection === undefined ||
		missionProjection.state !== "current" ||
		missionProjection.mission.missionId !== missionId
	) {
		throw new Error("The Verdict references a stale or terminal Mission.");
	}
	if (input.signal.missionId !== missionId || input.signal.participantId !== input.execution.participantId) {
		throw new Error("The Verdict Signal fails the Mission and participant fence.");
	}
	const mandate = readMandate(input.projectPath, missionProjection.mission.mandateId, input.projectTrusted);
	if (mandate === undefined) {
		throw new Error("The governing Mandate is unavailable for this Verdict.");
	}
	if (input.params.decision === "retry") {
		if (!isCompleteAssignment(input.normalizedAssignment)) {
			throw new Error("Retry requires a complete successor Mission assignment.");
		}
		if (!isCompleteRetryHandoff(input.normalizedRetryHandoff)) {
			throw new Error("Retry requires a complete retry handoff.");
		}
	}
	return { missionId, missionProjection };
}

function persistVerdict(input: {
	verdict: VerdictRecord;
	missionId: string | undefined;
	missionProjection: MissionProjection | undefined;
	context: ExtensionContext;
	projectTrusted: boolean;
	requeueSubmission: RequeueSubmission;
}) {
	const { verdict, missionId, missionProjection, context, projectTrusted, requeueSubmission } = input;
	if (missionId !== undefined && verdict.decision === "retry") {
		return materializeRetryVerdict(verdict, missionProjection, context, projectTrusted);
	}
	let schemaVersion: 1 | 2 = 1;
	if (missionId !== undefined) {
		schemaVersion = 2;
	}
	if (verdict.decision === "finish" || verdict.decision === "reject") {
		const result = withArchiveLock(context.cwd, projectTrusted, () => {
			const execution = readExecutorRecord(context.cwd, verdict.executionId, projectTrusted);
			if (execution?.status !== ExecutorStatus.running) {
				throw new Error("The Execution changed before its terminal Verdict could be committed.");
			}
			appendArchiveRecord(
				context.cwd,
				{ schemaVersion, type: "verdict", workId: verdict.workId, executionId: verdict.executionId, payload: verdict },
				projectTrusted,
			);
			writeExecutorRecord({ ...execution, status: terminalExecutorStatus(verdict.decision) }, projectTrusted);
			return verdictResult(verdict, false);
		});
		if (verdict.decision === "finish" && missionId !== undefined) {
			markPullRequestReviewable({
				projectPath: context.cwd,
				projectTrusted,
				workId: verdict.workId,
				missionId,
				executionId: verdict.executionId,
			});
		}
		return result;
	}
	appendArchiveRecord(
		context.cwd,
		{ schemaVersion, type: "verdict", workId: verdict.workId, executionId: verdict.executionId, payload: verdict },
		projectTrusted,
	);
	if (verdict.decision === "retry") {
		updateExecutorRecord(context.cwd, verdict.executionId, { status: ExecutorStatus.failed }, projectTrusted);
		return verdictResult(verdict, requeueSubmission(context.cwd, verdict.workId, projectTrusted));
	}
	return verdictResult(verdict, false);
}

function materializeRetryVerdict(
	verdict: VerdictRecord,
	missionProjection: MissionProjection | undefined,
	context: ExtensionContext,
	projectTrusted: boolean,
) {
	const mission = missionProjection?.mission;
	if (
		mission === undefined ||
		verdict.governingMandateId === undefined ||
		verdict.issuedByParticipantId === undefined ||
		verdict.successorAssignment === undefined
	) {
		throw new Error("Retry is missing governing lifecycle data.");
	}
	const successorMissionId = nanoid();
	const successor: MissionRecord = {
		missionId: successorMissionId,
		workId: verdict.workId,
		mandateId: mission.mandateId,
		predecessorMissionId: mission.missionId,
		causedByVerdictId: verdict.verdictId,
		assignment: verdict.successorAssignment,
		assignedParticipantId: `executor:${successorMissionId}`,
		createdAt: new Date().toISOString(),
	};
	withArchiveLock(context.cwd, projectTrusted, () => {
		const currentMission = readCurrentMission(context.cwd, verdict.workId, projectTrusted);
		if (currentMission?.mission.missionId !== mission.missionId || currentMission.state !== "current") {
			throw new Error("The Mission changed before Retry could be materialized.");
		}
		const currentExecution = readExecutorRecord(context.cwd, verdict.executionId, projectTrusted);
		if (currentExecution?.status !== ExecutorStatus.running) {
			throw new Error("The Execution changed before Retry could be materialized.");
		}
		appendArchiveRecords(
			context.cwd,
			[
				{
					schemaVersion: 2,
					type: "verdict",
					workId: verdict.workId,
					executionId: verdict.executionId,
					payload: verdict,
				},
				{
					schemaVersion: 2,
					type: "execution",
					workId: currentExecution.workId,
					executionId: currentExecution.executionId,
					payload: { ...currentExecution, status: ExecutorStatus.failed },
				},
				{ schemaVersion: 2, type: "mission", workId: successor.workId, payload: successor },
			],
			projectTrusted,
		);
	});
	return verdictResult(verdict, true);
}

function normalizeVerdictParams(
	params: VerdictInput,
	reason: string,
	retryHandoff: RetryHandoff | undefined,
	successorAssignment: KhalaWork | undefined,
): NormalizedVerdictInput {
	const normalized: NormalizedVerdictInput = { ...params, reason };
	if (retryHandoff !== undefined) {
		normalized.retryHandoff = retryHandoff;
	}
	if (successorAssignment !== undefined) {
		normalized.successorAssignment = successorAssignment;
	}
	return normalized;
}

function createVerdictFields(
	retryHandoff: RetryHandoff | undefined,
	successorAssignment: KhalaWork | undefined,
): { retryHandoff?: RetryHandoff; successorAssignment?: KhalaWork } {
	const fields: { retryHandoff?: RetryHandoff; successorAssignment?: KhalaWork } = {};
	if (retryHandoff !== undefined) {
		fields.retryHandoff = retryHandoff;
	}
	if (successorAssignment !== undefined) {
		fields.successorAssignment = successorAssignment;
	}
	return fields;
}

function createVerdictRecord(input: {
	params: VerdictInput;
	reason: string;
	missionId: string | undefined;
	missionProjection: MissionProjection | undefined;
	normalizedAssignment: KhalaWork | undefined;
	normalizedRetryHandoff: RetryHandoff | undefined;
	projectPath: string;
}): VerdictRecord {
	const base = {
		workId: input.params.workId,
		executionId: input.params.executionId,
		signalId: input.params.signalId,
		decision: input.params.decision,
		reason: input.reason,
		verdictId: nanoid(),
		issuedAt: new Date().toISOString(),
	};
	const verdictFields = createVerdictFields(input.normalizedRetryHandoff, input.normalizedAssignment);
	if (input.missionId !== undefined && input.missionProjection !== undefined) {
		const missionFields = {
			missionId: input.missionId,
			governingMandateId: input.missionProjection.mission.mandateId,
			issuedByParticipantId: conclaveParticipantId(input.projectPath),
		};
		return { ...base, ...missionFields, ...verdictFields };
	}
	return { ...base, ...verdictFields };
}

function terminalExecutorStatus(decision: VerdictRecord["decision"]): ExecutorStatusValue {
	if (decision === "finish") {
		return ExecutorStatus.finished;
	}
	return ExecutorStatus.failed;
}

function isCompleteRetryHandoff(handoff: RetryHandoff | undefined): handoff is RetryHandoff {
	return (
		handoff !== undefined &&
		handoff.failedCriteria.length > 0 &&
		handoff.failedCriteria.every((item) => item.trim().length > 0) &&
		handoff.completedWork.length > 0 &&
		handoff.completedWork.every((item) => item.trim().length > 0) &&
		handoff.requiredChanges.length > 0 &&
		handoff.requiredChanges.every((item) => item.trim().length > 0) &&
		handoff.nonGoals.length > 0 &&
		handoff.nonGoals.every((item) => item.trim().length > 0) &&
		handoff.validation.length > 0 &&
		handoff.validation.every((item) => item.trim().length > 0)
	);
}

function isCompleteAssignment(assignment: KhalaWork | undefined): assignment is KhalaWork {
	return (
		assignment !== undefined &&
		assignment.title.trim().length > 0 &&
		assignment.objective.trim().length > 0 &&
		assignment.scope.trim().length > 0 &&
		assignment.acceptanceCriteria.length > 0 &&
		assignment.acceptanceCriteria.every((item) => item.trim().length > 0) &&
		assignment.plan.length > 0 &&
		assignment.plan.every((item) => item.trim().length > 0) &&
		assignment.validation.length > 0 &&
		assignment.validation.every((item) => item.trim().length > 0) &&
		assignment.constraints.every((item) => item.trim().length > 0)
	);
}

function isSameVerdict(existing: VerdictRecord, input: NormalizedVerdictInput): boolean {
	return (
		existing.workId === input.workId &&
		existing.executionId === input.executionId &&
		existing.signalId === input.signalId &&
		existing.decision === input.decision &&
		existing.reason === input.reason &&
		JSON.stringify(existing.retryHandoff) === JSON.stringify(input.retryHandoff) &&
		JSON.stringify(existing.successorAssignment) === JSON.stringify(input.successorAssignment)
	);
}

function verdictResult(verdict: VerdictRecord, successorMaterialized: boolean) {
	let text = `Verdict ${verdict.verdictId} recorded.`;
	if (verdict.decision === "retry" && successorMaterialized) {
		if (verdict.missionId === undefined) {
			text = `Verdict ${verdict.verdictId} recorded; Work ${verdict.workId} was requeued for a successor execution.`;
		} else {
			text = `Verdict ${verdict.verdictId} recorded; successor Mission materialized for Work ${verdict.workId}.`;
		}
	}
	return Promise.resolve({ content: [{ type: "text" as const, text }], details: verdict });
}

function conclaveParticipantId(projectPath: string): string {
	return `conclave:${createHash("sha256").update(projectPath).digest("hex").slice(0, PARTICIPANT_HASH_LENGTH)}`;
}

export { createVerdictRecord, isSameVerdict, normalizeVerdictParams, processNewVerdict, verdictResult };
