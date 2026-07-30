// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Recovery reconciles terminal runtime, review handoff, and retry evidence in one locked pass.
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { appendArchiveRecord, appendArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	listExecutionRecords,
	listPullRequestRecords,
	listSignalRecords,
	listVerdictRecords,
	readCurrentMission,
	readMandate,
} from "./khala-archive-projections.js";
import { writeExecutorRecord } from "./khala-executor-registry.js";
import {
	ExecutorStatus,
	type ExecutorStatusValue,
	type KhalaWork,
	type MissionRecord,
	type PullRequestRecord,
	type SignalRecord,
	type VerdictRecord,
} from "./khala-model.js";
import { markPullRequestReviewable } from "./khala-review.js";
import type { MissionAssignmentInput } from "./khala-verdict.js";

function recoverTerminalExecutionStates(projectPath: string, projectTrusted: boolean): void {
	const reviewable: Array<{ workId: string; missionId: string; executionId: string }> = [];
	withArchiveLock(projectPath, projectTrusted, () => {
		const executions = new Map(
			listExecutionRecords(projectPath, projectTrusted).map((execution) => [execution.executionId, execution]),
		);
		for (const verdict of listVerdictRecords(projectPath, projectTrusted)) {
			if (verdict.decision === "finish" || verdict.decision === "reject") {
				if (verdict.decision === "finish" && verdict.missionId !== undefined) {
					reviewable.push({ workId: verdict.workId, missionId: verdict.missionId, executionId: verdict.executionId });
				}
				const execution = executions.get(verdict.executionId);
				if (execution !== undefined && execution.workId !== verdict.workId) {
					throw new Error(`Verdict ${verdict.verdictId} references an Execution from another Work.`);
				}
				if (execution?.status === "running") {
					let status: ExecutorStatusValue = ExecutorStatus.failed;
					if (verdict.decision === "finish") {
						status = ExecutorStatus.finished;
					}
					const recovered = { ...execution, status };
					writeExecutorRecord(recovered, projectTrusted);
					executions.set(execution.executionId, recovered);
				}
			}
		}
	});
	for (const input of reviewable) {
		markPullRequestReviewable({ projectPath, projectTrusted, ...input });
	}
}

function latestPullRequestForMission(
	projectPath: string,
	missionId: string,
	projectTrusted: boolean,
): PullRequestRecord | undefined {
	let latest: PullRequestRecord | undefined;
	for (const candidate of listPullRequestRecords(projectPath, projectTrusted)) {
		if (candidate.missionId === missionId) {
			latest = candidate;
		}
	}
	return latest;
}

function readMissionSignal(projectPath: string, signalId: string, projectTrusted: boolean): SignalRecord | undefined {
	return listSignalRecords(projectPath, projectTrusted).find((candidate) => candidate.signalId === signalId);
}

function materializeReviewRequestedSuccessor(projectPath: string, projectTrusted: boolean, workId: string): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const current = readCurrentMission(projectPath, workId, projectTrusted);
		const terminal = current?.terminalVerdict;
		if (current === undefined || current.state !== "finished" || terminal?.decision !== "finish") {
			return false;
		}
		const review = latestPullRequestForMission(projectPath, current.mission.missionId, projectTrusted);
		if (review?.status !== "changes-requested") {
			return false;
		}
		const signal = readMissionSignal(projectPath, terminal.signalId, projectTrusted);
		const mandate = readMandate(projectPath, current.mission.mandateId, projectTrusted);
		if (
			signal === undefined ||
			signal.workId !== workId ||
			signal.executionId !== terminal.executionId ||
			signal.missionId !== current.mission.missionId ||
			mandate === undefined
		) {
			throw new Error("A changes-requested review cannot be retried without its Mission evidence.");
		}
		const successorMissionId = nanoid();
		const verdict: VerdictRecord = {
			workId,
			executionId: terminal.executionId,
			signalId: signal.signalId,
			missionId: current.mission.missionId,
			governingMandateId: mandate.mandateId,
			issuedByParticipantId: conclaveParticipantId(projectPath),
			decision: "retry",
			reason: `Maintainer requested changes: ${review.reviewFeedback.join("; ") || "review feedback was recorded."}`,
			verdictId: nanoid(),
			issuedAt: new Date().toISOString(),
			sourcePullRequestId: review.pullRequestId,
			successorAssignment: mandate.terms,
		};
		const successor: MissionRecord = {
			missionId: successorMissionId,
			workId,
			mandateId: mandate.mandateId,
			predecessorMissionId: current.mission.missionId,
			causedByVerdictId: verdict.verdictId,
			assignment: mandate.terms,
			assignedParticipantId: `executor:${successorMissionId}`,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecords(
			projectPath,
			[
				{ schemaVersion: 2, type: "verdict", workId, executionId: verdict.executionId, payload: verdict },
				{ schemaVersion: 2, type: "mission", workId, payload: successor },
			],
			projectTrusted,
		);
		return true;
	});
}

function materializeMissingRetrySuccessor(
	projectPath: string,
	projectTrusted: boolean,
	verdict: VerdictRecord,
): boolean {
	const { missionId, governingMandateId, successorAssignment } = verdict;
	if (missionId === undefined || governingMandateId === undefined || successorAssignment === undefined) {
		return false;
	}
	return withArchiveLock(projectPath, projectTrusted, () => {
		const current = readCurrentMission(projectPath, verdict.workId, projectTrusted);
		if (current === undefined || current.state !== "retry-pending" || current.mission.missionId !== missionId) {
			return false;
		}
		const successorMissionId = nanoid();
		const successor: MissionRecord = {
			missionId: successorMissionId,
			workId: verdict.workId,
			mandateId: governingMandateId,
			predecessorMissionId: missionId,
			causedByVerdictId: verdict.verdictId,
			assignment: successorAssignment,
			assignedParticipantId: `executor:${successorMissionId}`,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "mission", workId: successor.workId, payload: successor },
			projectTrusted,
		);
		return true;
	});
}

const PARTICIPANT_HASH_LENGTH = 16;

function conclaveParticipantId(projectPath: string): string {
	return `conclave:${createHash("sha256").update(projectPath).digest("hex").slice(0, PARTICIPANT_HASH_LENGTH)}`;
}

function normalizeAssignment(assignment: MissionAssignmentInput | undefined): KhalaWork | undefined {
	if (assignment === undefined) {
		return;
	}
	return {
		title: assignment.title.trim(),
		objective: assignment.objective.trim(),
		context: assignment.context.trim(),
		scope: assignment.scope.trim(),
		acceptanceCriteria: assignment.acceptanceCriteria.map((item) => item.trim()),
		constraints: assignment.constraints.map((item) => item.trim()),
		plan: assignment.plan.map((item) => item.trim()),
		validation: assignment.validation.map((item) => item.trim()),
	};
}

export {
	materializeMissingRetrySuccessor,
	materializeReviewRequestedSuccessor,
	normalizeAssignment,
	recoverTerminalExecutionStates,
};
