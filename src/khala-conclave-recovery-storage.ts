import process from "node:process";
import { nanoid } from "nanoid";
import { appendArchiveRecord, appendArchiveRecords, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import { activeCoordinationHolds, readCurrentMission } from "./khala-archive-projections.js";
import {
	AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
	type SubmissionRecoveryClaim,
	type SubmissionRecoveryOutcome,
	type SubmissionSnapshot,
} from "./khala-conclave-storage.js";
import { listExecutorRecords } from "./khala-executor-registry.js";
import {
	type ConclaveRecoveryRecord,
	ConclaveRecoveryStatus,
	ConclaveWakeStatus,
	ExecutorStatus,
	isConclaveRecoveryRecord,
	isConclaveWakeRecord,
	isWorkSubmission,
	type KhalaArchiveAppend,
	type KhalaArchiveRecord,
	type KhalaWorkSubmission,
	WorkSubmissionStatus,
} from "./khala-model.js";

function getRecoverableSubmissions(projectPath: string, projectTrusted = false): readonly KhalaWorkSubmission[] {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const records = listArchiveRecords(projectPath, projectTrusted);
		return [...latestSubmissionSnapshots(records).values()]
			.filter((snapshot) => isAutomaticRecoveryEligible(projectPath, snapshot, records, projectTrusted))
			.map((snapshot) => snapshot.submission);
	});
}

function claimSubmissionRecovery(
	projectPath: string,
	workId: string,
	ownerProcessId: number,
	projectTrusted = false,
): SubmissionRecoveryClaim | undefined {
	if (!(Number.isSafeInteger(ownerProcessId) && ownerProcessId > 0)) {
		throw new Error("A Conclave recovery claim requires a positive process ID.");
	}
	return withArchiveLock(projectPath, projectTrusted, () =>
		claimSubmissionRecoveryWithinLock(projectPath, workId, ownerProcessId, projectTrusted),
	);
}

function claimSubmissionRecoveryWithinLock(
	projectPath: string,
	workId: string,
	ownerProcessId: number,
	projectTrusted: boolean,
): SubmissionRecoveryClaim | undefined {
	const records = listArchiveRecords(projectPath, projectTrusted);
	const snapshot = latestSubmissionSnapshots(records).get(workId);
	if (snapshot === undefined || !isAutomaticRecoveryEligible(projectPath, snapshot, records, projectTrusted)) {
		return;
	}
	const recoveries = recoveryRecordsFor(records, snapshot.recordId);
	if (recoveries.some((candidate) => candidate.status === ConclaveRecoveryStatus.exhausted)) {
		return;
	}
	const claims = recoveries.filter((candidate) => candidate.status === ConclaveRecoveryStatus.claimed);
	const latestClaim = claims.at(-1);
	if (
		latestClaim !== undefined &&
		!hasWakeResult(records, latestClaim.recoveryId) &&
		isProcessAlive(latestClaim.ownerProcessId)
	) {
		return;
	}
	if (claims.length >= AUTOMATIC_RECOVERY_MAX_ATTEMPTS) {
		appendArchiveRecord(projectPath, recoveryExhaustionAppend(workId, snapshot.recordId), projectTrusted);
		return;
	}
	const recovery = {
		recoveryId: nanoid(),
		workId,
		submissionRecordId: snapshot.recordId,
		status: ConclaveRecoveryStatus.claimed,
		attempt: claims.length + 1,
		maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
		ownerProcessId,
		claimedAt: new Date().toISOString(),
	} as const;
	appendArchiveRecord(
		projectPath,
		{ schemaVersion: 2, type: "conclave-recovery", workId, payload: recovery },
		projectTrusted,
	);
	return { recovery, submission: snapshot.submission };
}

function completeSubmissionRecovery(
	projectPath: string,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
	projectTrusted = false,
): void {
	withArchiveLock(projectPath, projectTrusted, () =>
		completeSubmissionRecoveryWithinLock(projectPath, claim, outcome, projectTrusted),
	);
}

function completeSubmissionRecoveryWithinLock(
	projectPath: string,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
	projectTrusted: boolean,
): void {
	const records = listArchiveRecords(projectPath, projectTrusted);
	const persistedClaim = recoveryRecordsFor(records, claim.recovery.submissionRecordId).some(
		(candidate) =>
			candidate.status === ConclaveRecoveryStatus.claimed &&
			candidate.recoveryId === claim.recovery.recoveryId &&
			candidate.workId === claim.submission.workId,
	);
	if (!persistedClaim) {
		throw new Error(`Conclave recovery ${claim.recovery.recoveryId} is not an authoritative claim.`);
	}
	if (hasWakeResult(records, claim.recovery.recoveryId)) {
		return;
	}
	const inputs: KhalaArchiveAppend[] = [recoveryWakeAppend(claim, outcome)];
	if (
		outcome.status === ConclaveWakeStatus.failed &&
		claim.recovery.attempt === claim.recovery.maxAttempts &&
		!hasExhaustedRecovery(records, claim.recovery.submissionRecordId)
	) {
		inputs.push(recoveryExhaustionAppend(claim.submission.workId, claim.recovery.submissionRecordId));
	}
	appendArchiveRecords(projectPath, inputs, projectTrusted);
}

function recoveryWakeAppend(claim: SubmissionRecoveryClaim, outcome: SubmissionRecoveryOutcome): KhalaArchiveAppend {
	let payload: unknown;
	if (outcome.status === ConclaveWakeStatus.woken) {
		payload = {
			wakeId: claim.recovery.recoveryId,
			workId: claim.submission.workId,
			status: ConclaveWakeStatus.woken,
			attemptedAt: outcome.attemptedAt,
		};
	} else {
		payload = {
			wakeId: claim.recovery.recoveryId,
			workId: claim.submission.workId,
			status: ConclaveWakeStatus.failed,
			attemptedAt: outcome.attemptedAt,
			failure: outcome.failure,
			recovery: outcome.recovery,
		};
	}
	return { schemaVersion: 2, type: "conclave-wake", workId: claim.submission.workId, payload };
}

function isAutomaticRecoveryEligible(
	projectPath: string,
	snapshot: SubmissionSnapshot,
	records: readonly KhalaArchiveRecord[],
	projectTrusted: boolean,
): boolean {
	const { submission } = snapshot;
	if (submission.status !== WorkSubmissionStatus.queued && submission.status !== WorkSubmissionStatus.admitted) {
		return false;
	}
	if (hasCompletedDecision(records, snapshot) || hasExhaustedRecovery(records, snapshot.recordId)) {
		return false;
	}
	const executions = listExecutorRecords(projectPath, projectTrusted);
	if (submission.status === WorkSubmissionStatus.queued) {
		return !executions.some(
			(execution) =>
				execution.workId === submission.workId &&
				execution.kind === "observer" &&
				(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
		);
	}
	const current = readCurrentMission(projectPath, submission.workId, projectTrusted);
	if (current === undefined) {
		return true;
	}
	if (current.state !== "current") {
		return false;
	}
	if (
		activeCoordinationHolds(projectPath, projectTrusted).some(
			(hold) => hold.workId === submission.workId && hold.missionId === current.mission.missionId,
		)
	) {
		return false;
	}
	return !executions.some(
		(execution) => execution.purpose?.kind === "mission" && execution.purpose.missionId === current.mission.missionId,
	);
}

function hasCompletedDecision(records: readonly KhalaArchiveRecord[], snapshot: SubmissionSnapshot): boolean {
	const transitionIndex = records.findIndex((record) => record.recordId === snapshot.recordId);
	return records
		.slice(transitionIndex + 1)
		.some(
			(record) =>
				record.type === "conclave-wake" &&
				record.workId === snapshot.submission.workId &&
				isConclaveWakeRecord(record.payload) &&
				record.payload.status === ConclaveWakeStatus.woken,
		);
}

function hasExhaustedRecovery(records: readonly KhalaArchiveRecord[], submissionRecordId: string): boolean {
	return recoveryRecordsFor(records, submissionRecordId).some(
		(candidate) => candidate.status === ConclaveRecoveryStatus.exhausted,
	);
}

function hasWakeResult(records: readonly KhalaArchiveRecord[], recoveryId: string): boolean {
	return records.some(
		(record) =>
			record.type === "conclave-wake" && isConclaveWakeRecord(record.payload) && record.payload.wakeId === recoveryId,
	);
}

function recoveryRecordsFor(
	records: readonly KhalaArchiveRecord[],
	submissionRecordId: string,
): ConclaveRecoveryRecord[] {
	const recoveries: ConclaveRecoveryRecord[] = [];
	for (const record of records) {
		if (
			record.type === "conclave-recovery" &&
			isConclaveRecoveryRecord(record.payload) &&
			record.payload.submissionRecordId === submissionRecordId
		) {
			recoveries.push(record.payload);
		}
	}
	return recoveries;
}

function latestSubmissionSnapshots(records: readonly KhalaArchiveRecord[]): Map<string, SubmissionSnapshot> {
	const submissions = new Map<string, SubmissionSnapshot>();
	for (const record of records) {
		if (record.type === "submission" && isWorkSubmission(record.payload)) {
			submissions.set(record.workId, { submission: record.payload, recordId: record.recordId });
		}
	}
	return submissions;
}

function recoveryExhaustionAppend(workId: string, submissionRecordId: string): KhalaArchiveAppend {
	return {
		schemaVersion: 2,
		type: "conclave-recovery",
		workId,
		payload: {
			recoveryId: nanoid(),
			workId,
			submissionRecordId,
			status: ConclaveRecoveryStatus.exhausted,
			attempt: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
			maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
			exhaustedAt: new Date().toISOString(),
			reason: "Automatic Conclave recovery exhausted its durable retry limit.",
		},
	};
}

function isProcessAlive(processId: number): boolean {
	// Archive recovery coordinates processes on one host. A live owner keeps its
	// claim; a dead owner consumes that durable attempt before another can claim.
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "ESRCH"
		) {
			return false;
		}
		return true;
	}
}

export { claimSubmissionRecovery, completeSubmissionRecovery, getRecoverableSubmissions };
