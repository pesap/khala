// biome-ignore-all lint/style/noExcessiveLinesPerFile: Recovery claims, renewals, and outcomes share one Archive-locked state machine.
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
	CONCLAVE_RECOVERY_CLAIM_LEASE_MS,
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
	ownerId: string,
	projectTrusted = false,
): SubmissionRecoveryClaim | undefined {
	if (ownerId.trim().length === 0) {
		throw new Error("A Conclave recovery claim requires a non-empty owner ID.");
	}
	return withArchiveLock(projectPath, projectTrusted, () =>
		claimSubmissionRecoveryWithinLock(projectPath, workId, ownerId, projectTrusted),
	);
}

function claimSubmissionRecoveryWithinLock(
	projectPath: string,
	workId: string,
	ownerId: string,
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
		Date.parse(latestRecoveryLeaseExpiration(recoveries, latestClaim.recoveryId, latestClaim.leaseExpiresAt)) >
			Date.now()
	) {
		return;
	}
	if (claims.length >= AUTOMATIC_RECOVERY_MAX_ATTEMPTS) {
		appendArchiveRecord(projectPath, recoveryExhaustionAppend(workId, snapshot.recordId), projectTrusted);
		return;
	}
	const claimedAt = new Date();
	const recovery = {
		recoveryId: nanoid(),
		workId,
		submissionRecordId: snapshot.recordId,
		status: ConclaveRecoveryStatus.claimed,
		attempt: claims.length + 1,
		maxAttempts: AUTOMATIC_RECOVERY_MAX_ATTEMPTS,
		ownerId,
		claimedAt: claimedAt.toISOString(),
		leaseExpiresAt: new Date(claimedAt.getTime() + CONCLAVE_RECOVERY_CLAIM_LEASE_MS).toISOString(),
	} as const;
	appendArchiveRecord(
		projectPath,
		{ schemaVersion: 2, type: "conclave-recovery", workId, payload: recovery },
		projectTrusted,
	);
	return { recovery, submission: snapshot.submission };
}

function renewSubmissionRecovery(projectPath: string, claim: SubmissionRecoveryClaim, projectTrusted = false): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const records = listArchiveRecords(projectPath, projectTrusted);
		const recoveries = recoveryRecordsFor(records, claim.recovery.submissionRecordId);
		const latestClaim = recoveries.filter((candidate) => candidate.status === ConclaveRecoveryStatus.claimed).at(-1);
		if (
			latestClaim?.recoveryId !== claim.recovery.recoveryId ||
			latestClaim.ownerId !== claim.recovery.ownerId ||
			hasWakeResult(records, claim.recovery.recoveryId) ||
			Date.parse(latestRecoveryLeaseExpiration(recoveries, latestClaim.recoveryId, latestClaim.leaseExpiresAt)) <=
				Date.now()
		) {
			return false;
		}
		const renewedAt = new Date();
		appendArchiveRecord(
			projectPath,
			{
				schemaVersion: 2,
				type: "conclave-recovery",
				workId: claim.submission.workId,
				payload: {
					recoveryId: claim.recovery.recoveryId,
					workId: claim.submission.workId,
					submissionRecordId: claim.recovery.submissionRecordId,
					status: ConclaveRecoveryStatus.renewed,
					attempt: claim.recovery.attempt,
					maxAttempts: claim.recovery.maxAttempts,
					ownerId: claim.recovery.ownerId,
					renewedAt: renewedAt.toISOString(),
					leaseExpiresAt: new Date(renewedAt.getTime() + CONCLAVE_RECOVERY_CLAIM_LEASE_MS).toISOString(),
				},
			},
			projectTrusted,
		);
		return true;
	});
}

function completeSubmissionRecovery(
	projectPath: string,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
	projectTrusted = false,
): boolean {
	return withArchiveLock(projectPath, projectTrusted, () =>
		completeSubmissionRecoveryWithinLock(projectPath, claim, outcome, projectTrusted),
	);
}

function completeSubmissionRecoveryWithinLock(
	projectPath: string,
	claim: SubmissionRecoveryClaim,
	outcome: SubmissionRecoveryOutcome,
	projectTrusted: boolean,
): boolean {
	const records = listArchiveRecords(projectPath, projectTrusted);
	const claims = recoveryRecordsFor(records, claim.recovery.submissionRecordId).filter(
		(candidate) => candidate.status === ConclaveRecoveryStatus.claimed,
	);
	const persistedClaim = claims.find(
		(candidate) =>
			candidate.recoveryId === claim.recovery.recoveryId &&
			candidate.workId === claim.submission.workId &&
			candidate.ownerId === claim.recovery.ownerId,
	);
	if (persistedClaim === undefined) {
		throw new Error(`Conclave recovery ${claim.recovery.recoveryId} is not an authoritative claim.`);
	}
	if (claims.at(-1)?.recoveryId !== claim.recovery.recoveryId) {
		return false;
	}
	if (hasWakeResult(records, claim.recovery.recoveryId)) {
		return true;
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
	return true;
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

function latestRecoveryLeaseExpiration(
	recoveries: readonly ConclaveRecoveryRecord[],
	recoveryId: string,
	claimedLeaseExpiresAt: string,
): string {
	let leaseExpiresAt = claimedLeaseExpiresAt;
	for (const recovery of recoveries) {
		if (recovery.status === ConclaveRecoveryStatus.renewed && recovery.recoveryId === recoveryId) {
			const { leaseExpiresAt: renewedLeaseExpiresAt } = recovery;
			leaseExpiresAt = renewedLeaseExpiresAt;
		}
	}
	return leaseExpiresAt;
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

export { claimSubmissionRecovery, completeSubmissionRecovery, getRecoverableSubmissions, renewSubmissionRecovery };
