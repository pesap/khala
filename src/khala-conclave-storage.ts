import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { KhalaWorkSubmission, WorkSubmissionRequest } from "./khala-model.js";

type SubmissionSnapshot = Readonly<{
	submission: KhalaWorkSubmission;
	recordId: string;
}>;

type SubmissionLaunchResult = Readonly<{
	target?: string | undefined;
	sandboxPath: string;
}>;

/**
 * Project-scoped durable storage for Conclave state. Submission state is
 * append-only; v1 launch states remain readable while v2 admission and review
 * states are the only states written by current code.
 */
interface ConclaveStorage {
	submit: (request: WorkSubmissionRequest & { projectTrusted?: boolean }) => { archivePath: string };
	getSubmission: (projectPath: string, workId: string, projectTrusted?: boolean) => SubmissionSnapshot | undefined;
	getPendingSubmission: (
		projectPath: string,
		workId: string,
		projectTrusted?: boolean,
	) => KhalaWorkSubmission | undefined;
	getPendingSubmissions: (projectPath: string, projectTrusted?: boolean) => readonly KhalaWorkSubmission[];
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

export type { ConclaveStorage, SubmissionLaunchResult, SubmissionSnapshot };
