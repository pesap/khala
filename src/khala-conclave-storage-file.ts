import { resolve } from "node:path";
import { appendArchiveRecord, getArchivePath, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	claimSubmissionRecovery,
	completeSubmissionRecovery,
	getRecoverableSubmissions,
	renewSubmissionRecovery,
} from "./khala-conclave-recovery-storage.js";
import {
	getConclaveSessionPath,
	getConclaveUserSessionPath,
	loadConclaveSession as loadConclaveModelSession,
} from "./khala-conclave-session-storage.js";
import type { ConclaveStorage, SubmissionLaunchResult, SubmissionSnapshot } from "./khala-conclave-storage.js";
import {
	isWorkSubmission,
	type KhalaWorkSubmission,
	type WorkSubmissionRequest,
	WorkSubmissionStatus,
} from "./khala-model.js";

function createFileConclaveStorage(): ConclaveStorage {
	return {
		submit,
		getSubmission,
		getPendingSubmission,
		getRecoverableSubmissions,
		claimSubmissionRecovery,
		renewSubmissionRecovery,
		completeSubmissionRecovery,
		claimSubmission,
		markSubmissionReviewing,
		markSubmissionQueued,
		admitSubmission,
		rejectSubmission,
		requeueSubmission,
		markSubmissionLaunched,
		loadConclaveSession,
		getConclaveSessionPath,
		getConclaveUserSessionPath,
	};
}

function loadConclaveSession(projectPath: string, userSessionPath?: string, projectTrusted = false) {
	const resolvedProjectPath = resolve(projectPath);
	return withArchiveLock(resolvedProjectPath, projectTrusted, () =>
		loadConclaveModelSession(resolvedProjectPath, userSessionPath, projectTrusted),
	);
}

function submit(request: WorkSubmissionRequest & { projectTrusted?: boolean }): { archivePath: string } {
	const projectPath = resolve(request.projectPath);
	const projectTrusted = request.projectTrusted ?? false;
	return withArchiveLock(projectPath, projectTrusted, () => {
		const existing = getSubmission(projectPath, request.workId, projectTrusted);
		if (existing !== undefined) {
			return { archivePath: existing.submission.archivePath };
		}
		const submission: KhalaWorkSubmission = {
			workId: request.workId,
			projectPath,
			status: WorkSubmissionStatus.queued,
			work: request.work,
			archivePath: getArchivePath(projectPath, projectTrusted),
		};
		appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "submission", workId: submission.workId, payload: submission },
			projectTrusted,
		);
		return { archivePath: submission.archivePath };
	});
}

function getSubmission(projectPath: string, workId: string, projectTrusted = false): SubmissionSnapshot | undefined {
	let latest: SubmissionSnapshot | undefined;
	for (const record of listArchiveRecords(projectPath, projectTrusted)) {
		if (record.type === "submission" && record.workId === workId && isWorkSubmission(record.payload)) {
			latest = { submission: record.payload, recordId: record.recordId };
		}
	}
	return latest;
}
function getPendingSubmission(
	projectPath: string,
	workId: string,
	projectTrusted = false,
): KhalaWorkSubmission | undefined {
	const snapshot = getSubmission(projectPath, workId, projectTrusted);
	if (snapshot === undefined) {
		return;
	}
	let pending: KhalaWorkSubmission | undefined;
	if (
		snapshot.submission.status === WorkSubmissionStatus.queued ||
		snapshot.submission.status === WorkSubmissionStatus.reviewing ||
		snapshot.submission.status === WorkSubmissionStatus.admitted ||
		snapshot.submission.status === WorkSubmissionStatus.launching
	) {
		pending = snapshot.submission;
	}
	return pending;
}

// Legacy launch callers retain their v1 launching state. New admission/mission
// flows use the explicit review and admission methods below.
function claimSubmission(projectPath: string, workId: string, projectTrusted = false): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot?.submission.status !== WorkSubmissionStatus.queued) {
			return false;
		}
		appendSubmissionState(
			projectPath,
			{ ...snapshot.submission, status: WorkSubmissionStatus.launching },
			projectTrusted,
			1,
		);
		return true;
	});
}

function markSubmissionReviewing(
	projectPath: string,
	workId: string,
	reviewAttemptId: string,
	projectTrusted = false,
): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot?.submission.status !== WorkSubmissionStatus.queued) {
			return false;
		}
		appendSubmissionState(
			projectPath,
			{ ...snapshot.submission, status: WorkSubmissionStatus.reviewing, reviewAttemptId },
			projectTrusted,
			2,
		);
		return true;
	});
}

function markSubmissionQueued(
	projectPath: string,
	workId: string,
	reviewAttemptIdOrTrusted?: string | boolean,
	projectTrusted = false,
): void {
	let reviewAttemptId: string | undefined;
	let effectiveProjectTrusted = projectTrusted;
	if (typeof reviewAttemptIdOrTrusted === "string") {
		reviewAttemptId = reviewAttemptIdOrTrusted;
	} else if (typeof reviewAttemptIdOrTrusted === "boolean") {
		effectiveProjectTrusted = reviewAttemptIdOrTrusted;
	}
	withArchiveLock(projectPath, effectiveProjectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, effectiveProjectTrusted);
		if (snapshot === undefined) {
			return;
		}
		const { submission } = snapshot;
		if (submission.status === WorkSubmissionStatus.launching) {
			appendSubmissionState(
				projectPath,
				{ ...submission, status: WorkSubmissionStatus.queued },
				effectiveProjectTrusted,
				1,
			);
			return;
		}
		if (
			submission.status === WorkSubmissionStatus.reviewing &&
			(reviewAttemptId === undefined || submission.reviewAttemptId === reviewAttemptId)
		) {
			appendSubmissionState(
				projectPath,
				{ ...submission, status: WorkSubmissionStatus.queued },
				effectiveProjectTrusted,
				2,
			);
		}
	});
}

function admitSubmission(projectPath: string, workId: string, mandateId: string, projectTrusted = false): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot === undefined) {
			return false;
		}
		if (snapshot.submission.status === WorkSubmissionStatus.admitted) {
			return snapshot.submission.mandateId === mandateId;
		}
		if (
			snapshot.submission.status !== WorkSubmissionStatus.queued &&
			snapshot.submission.status !== WorkSubmissionStatus.reviewing
		) {
			return false;
		}
		appendSubmissionState(
			projectPath,
			{ ...clearReviewMetadata(snapshot.submission), status: WorkSubmissionStatus.admitted, mandateId },
			projectTrusted,
			2,
		);
		return true;
	});
}

function rejectSubmission(projectPath: string, workId: string, reason: string, projectTrusted = false): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot === undefined) {
			return false;
		}
		if (snapshot.submission.status === WorkSubmissionStatus.rejected) {
			return snapshot.submission.rejectionReason === reason;
		}
		if (
			snapshot.submission.status !== WorkSubmissionStatus.queued &&
			snapshot.submission.status !== WorkSubmissionStatus.reviewing
		) {
			return false;
		}
		appendSubmissionState(
			projectPath,
			{ ...clearReviewMetadata(snapshot.submission), status: WorkSubmissionStatus.rejected, rejectionReason: reason },
			projectTrusted,
			2,
		);
		return true;
	});
}

function requeueSubmission(projectPath: string, workId: string, projectTrusted = false): boolean {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot?.submission.status !== WorkSubmissionStatus.launched) {
			return false;
		}
		appendSubmissionState(
			projectPath,
			{ ...clearRuntimeMetadata(snapshot.submission), status: WorkSubmissionStatus.queued },
			projectTrusted,
			1,
		);
		return true;
	});
}

function markSubmissionLaunched(
	projectPath: string,
	workId: string,
	result: SubmissionLaunchResult,
	projectTrusted = false,
): void {
	withArchiveLock(projectPath, projectTrusted, () => {
		const snapshot = getSubmission(projectPath, workId, projectTrusted);
		if (snapshot === undefined) {
			return;
		}
		const { submission } = snapshot;
		if (submission.status === WorkSubmissionStatus.launching) {
			const launched = { ...submission, status: WorkSubmissionStatus.launched, sandboxPath: result.sandboxPath };
			appendSubmissionState(projectPath, launched, projectTrusted, 1);
		}
		// Mission execution owns runtime location and status for v2 submissions.
		// Keep the submission admitted so recovery can still discover the Mission;
		// writing a v2 `launched` state would violate the v2 submission guard.
	});
}

function appendSubmissionState(
	projectPath: string,
	submission: KhalaWorkSubmission,
	projectTrusted: boolean,
	schemaVersion: 1 | 2,
): void {
	appendArchiveRecord(
		projectPath,
		{ schemaVersion, type: "submission", workId: submission.workId, payload: submission },
		projectTrusted,
	);
}
function clearReviewMetadata(submission: KhalaWorkSubmission): KhalaWorkSubmission {
	const { reviewAttemptId: _reviewAttemptId, rejectionReason: _rejectionReason, ...next } = submission;
	return next;
}
function clearRuntimeMetadata(submission: KhalaWorkSubmission): KhalaWorkSubmission {
	const { target: _target, sandboxPath: _sandboxPath, ...next } = submission;
	return next;
}

export { createFileConclaveStorage };
