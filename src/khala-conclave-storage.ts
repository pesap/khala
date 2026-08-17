import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
	ConclaveRecoveryClaimRecord,
	ConclaveWakeRecovery,
	KhalaWorkSubmission,
	WorkSubmissionRequest,
} from "./khala-model.js";

type SubmissionSnapshot = Readonly<{
	submission: KhalaWorkSubmission;
	recordId: string;
}>;

type SubmissionLaunchResult = Readonly<{
	sandboxPath: string;
}>;

type SubmissionRecoveryClaim = Readonly<{
	recovery: ConclaveRecoveryClaimRecord;
	submission: KhalaWorkSubmission;
}>;

type SubmissionRecoveryOutcome =
	| Readonly<{ status: "woken"; attemptedAt: string }>
	| Readonly<{
			status: "failed";
			attemptedAt: string;
			failure: string;
			recovery: ConclaveWakeRecovery;
	  }>;

const AUTOMATIC_RECOVERY_MAX_ATTEMPTS = 3;

/**
 * Project-scoped durable storage for Conclave state. Submission state is
 * append-only and current admission/review states are written by the runtime.
 */
interface ConclaveStorage {
	submit: (request: WorkSubmissionRequest & { projectTrusted?: boolean }) => { archivePath: string };
	getSubmission: (projectPath: string, workId: string, projectTrusted?: boolean) => SubmissionSnapshot | undefined;
	getPendingSubmission: (
		projectPath: string,
		workId: string,
		projectTrusted?: boolean,
	) => KhalaWorkSubmission | undefined;
	getRecoverableSubmissions: (projectPath: string, projectTrusted?: boolean) => readonly KhalaWorkSubmission[];
	claimSubmissionRecovery: (
		projectPath: string,
		workId: string,
		ownerId: string,
		projectTrusted?: boolean,
	) => SubmissionRecoveryClaim | undefined;
	renewSubmissionRecovery: (projectPath: string, claim: SubmissionRecoveryClaim, projectTrusted?: boolean) => boolean;
	completeSubmissionRecovery: (
		projectPath: string,
		claim: SubmissionRecoveryClaim,
		outcome: SubmissionRecoveryOutcome,
		projectTrusted?: boolean,
	) => boolean;
	claimSubmission: (projectPath: string, workId: string, projectTrusted?: boolean) => boolean;
	markSubmissionReviewing: (
		projectPath: string,
		workId: string,
		reviewAttemptId: string,
		projectTrusted?: boolean,
	) => boolean;
	markSubmissionQueued: (
		projectPath: string,
		workId: string,
		reviewAttemptIdOrTrusted?: string | boolean,
		projectTrusted?: boolean,
	) => void;
	admitSubmission: (projectPath: string, workId: string, mandateId: string, projectTrusted?: boolean) => boolean;
	rejectSubmission: (projectPath: string, workId: string, reason: string, projectTrusted?: boolean) => boolean;
	requeueSubmission: (projectPath: string, workId: string, projectTrusted?: boolean) => boolean;
	markSubmissionLaunched: (
		projectPath: string,
		workId: string,
		result: SubmissionLaunchResult,
		projectTrusted?: boolean,
	) => void;
	loadConclaveSession: (projectPath: string, userSessionPath?: string, projectTrusted?: boolean) => SessionManager;
	getConclaveSessionPath: (projectPath: string, projectTrusted?: boolean) => string | undefined;
	getConclaveUserSessionPath: (projectPath: string, projectTrusted?: boolean) => string | undefined;
}

export type {
	ConclaveStorage,
	SubmissionLaunchResult,
	SubmissionRecoveryClaim,
	SubmissionRecoveryOutcome,
	SubmissionSnapshot,
};
export { AUTOMATIC_RECOVERY_MAX_ATTEMPTS };
