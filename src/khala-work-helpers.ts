import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { appendArchiveRecords, withArchiveLock } from "./khala-archive.js";
import { readCurrentMission, readMandate } from "./khala-archive-projections.js";
import type { SubmissionSnapshot } from "./khala-conclave-storage.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { formatError } from "./khala-error.js";
import { listLearningRecords } from "./khala-learning.js";
import type { KhalaWork, KhalaWorkSubmission, LearningRecord, MandateRecord, MissionRecord } from "./khala-model.js";
import { KhalaWorkEntryStatus, KhalaWorkLaunchStatus, WorkSubmissionStatus } from "./khala-model.js";
import type {
	KhalaAdmissionResult,
	KhalaWorkDependencies,
	KhalaWorkDraft,
	KhalaWorkInput,
	KhalaWorkLaunchResult,
} from "./khala-work.js";

type PreparedExecutionLaunch = Readonly<{
	projectTrusted: boolean;
	snapshot: SubmissionSnapshot;
	submission: KhalaWorkSubmission;
	mandate: NonNullable<ReturnType<typeof readMandate>>;
	learning: readonly LearningRecord[];
	currentProjection: ReturnType<typeof readCurrentMission>;
}>;

function prepareExecutionLaunch(
	workId: string,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): PreparedExecutionLaunch | KhalaWorkLaunchResult {
	const projectTrusted = isProjectTrusted(context);
	const snapshot = dependencies.getSubmission(context.cwd, workId, projectTrusted);
	if (snapshot === undefined) {
		return rejectedWorkLaunch(`No authoritative Work Submission exists for ID ${workId}.`);
	}
	const { submission } = snapshot;
	if (submission.status !== WorkSubmissionStatus.admitted || submission.mandateId === undefined) {
		return rejectedWorkLaunch(`Work Submission ${workId} must be admitted under a Mandate before launch.`);
	}
	const mandate = readMandate(context.cwd, submission.mandateId, projectTrusted);
	if (mandate === undefined || mandate.workId !== workId) {
		return rejectedWorkLaunch(`Mandate ${submission.mandateId} is unavailable for Work ${workId}.`);
	}
	const learning = listLearningRecords(context.cwd, workId, projectTrusted);
	if (submission.work.context.trim().length === 0 && learning.length === 0) {
		return rejectedWorkLaunch("Work context is missing; the Conclave must launch an Observer first.");
	}
	const currentProjection = readCurrentMission(context.cwd, workId, projectTrusted);
	if (currentProjection?.state === "retry-pending") {
		return rejectedWorkLaunch(
			`Mission ${currentProjection.mission.missionId} has an incomplete Retry; recovery is required.`,
		);
	}
	if (currentProjection !== undefined && currentProjection.state !== "current") {
		return rejectedWorkLaunch(
			`Mission ${currentProjection.mission.missionId} is ${currentProjection.state} and cannot be launched.`,
		);
	}
	return { projectTrusted, snapshot, submission, mandate, learning, currentProjection };
}

function ensureMission(input: {
	projectPath: string;
	projectTrusted: boolean;
	workId: string;
	mandate: MandateRecord;
	existingMission: MissionRecord | undefined;
	assignedParticipantId: string;
}): MissionRecord {
	if (input.existingMission !== undefined) {
		return input.existingMission;
	}
	return withArchiveLock(input.projectPath, input.projectTrusted, () => {
		const current = readCurrentMission(input.projectPath, input.workId, input.projectTrusted);
		if (current?.state === "retry-pending") {
			throw new Error(`Mission ${current.mission.missionId} has an incomplete Retry; recovery is required.`);
		}
		if (current !== undefined) {
			return current.mission;
		}
		const mission: MissionRecord = {
			missionId: nanoid(),
			workId: input.workId,
			mandateId: input.mandate.mandateId,
			assignment: input.mandate.terms,
			assignedParticipantId: input.assignedParticipantId,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecords(
			input.projectPath,
			[{ schemaVersion: 2, type: "mission", workId: input.workId, payload: mission }],
			input.projectTrusted,
		);
		return mission;
	});
}

function toKhalaWork(params: KhalaWorkInput): KhalaWork {
	return {
		title: deriveWorkTitle(params.title, params.objective),
		objective: params.objective.trim(),
		context: params.context?.trim() ?? "",
		scope: params.scope.trim(),
		acceptanceCriteria: params.acceptanceCriteria.map((value) => value.trim()),
		constraints: params.constraints.map((value) => value.trim()),
		plan: params.plan.map((value) => value.trim()),
		validation: params.validation.map((value) => value.trim()),
	};
}

function readLatestWorkDraft(context: ExtensionContext): KhalaWorkDraft | null {
	const entries = context.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === KhalaEntryType.work) {
			if (isKhalaWorkDraft(entry.data)) {
				return entry.data;
			}
			return null;
		}
	}
	return null;
}

function isKhalaWorkDraft(data: unknown): data is KhalaWorkDraft {
	if (typeof data !== "object" || data === null || !("status" in data) || !("workId" in data)) {
		return false;
	}
	return data.status === KhalaWorkEntryStatus.draft && typeof data.workId === "string" && data.workId.length > 0;
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function rejectedWorkLaunch(message: string): KhalaWorkLaunchResult {
	return {
		content: [{ type: "text", text: message }],
		details: { status: KhalaWorkLaunchStatus.rejected, reason: message },
		isError: true,
	};
}

function rejectedAdmission(message: string): KhalaAdmissionResult {
	return {
		content: [{ type: "text", text: message }],
		details: { status: "rejected", reason: message },
		isError: true,
	};
}

function admissionResult(mandate: MandateRecord): KhalaAdmissionResult {
	return {
		content: [
			{
				type: "text",
				text: `Work ${mandate.workId} admitted under Mandate ${mandate.mandateId} revision ${mandate.revision}.`,
			},
		],
		details: { workId: mandate.workId, mandateId: mandate.mandateId, revision: mandate.revision, status: "admitted" },
	};
}

function launchedResult(input: {
	workId: string;
	mission: MissionRecord;
	executionId: string;
	executorName: string;
	destination: string;
	sandboxPath: string;
	mandateId?: string;
}): KhalaWorkLaunchResult {
	const mandateId = input.mandateId ?? input.mission.mandateId;
	return {
		content: [
			{
				type: "text",
				text: `Executor ${input.executorName} launched for Work ${input.workId} in ${input.destination}.`,
			},
		],
		details: {
			status: KhalaWorkLaunchStatus.launched,
			workId: input.workId,
			executionId: input.executionId,
			executorName: input.executorName,
			destination: input.destination,
			sandboxPath: input.sandboxPath,
			missionId: input.mission.missionId,
			mandateId,
		},
	};
}

function admittedSubmissionState(submission: KhalaWorkSubmission, mandateId: string): KhalaWorkSubmission {
	const { reviewAttemptId: _reviewAttemptId, rejectionReason: _rejectionReason, ...next } = submission;
	return { ...next, status: WorkSubmissionStatus.admitted, mandateId };
}

function queueWork(
	pi: ExtensionAPI,
	work: KhalaWork,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): Promise<KhalaWorkLaunchResult> {
	const draft = readLatestWorkDraft(context);
	if (draft === null) {
		return Promise.resolve(rejectedWorkLaunch("There is no active Khala Work draft to submit."));
	}
	return dependencies
		.submitWork({ workId: draft.workId, projectPath: context.cwd, work, projectTrusted: isProjectTrusted(context) })
		.then((queued): KhalaWorkLaunchResult => {
			pi.appendEntry(KhalaEntryType.work, {
				status: KhalaWorkEntryStatus.queued,
				workId: draft.workId,
				title: work.title,
				archivePath: queued.archivePath,
			});
			return {
				content: [
					{
						type: "text" as const,
						text: `Work "${work.title}" was sent to the dedicated project Conclave and queued for admission.`,
					},
				],
				details: { status: KhalaWorkLaunchStatus.queued, workId: draft.workId, archivePath: queued.archivePath },
			};
		})
		.catch(
			(error: unknown): KhalaWorkLaunchResult => rejectedWorkLaunch(`Work submission failed: ${formatError(error)}`),
		);
}

function deriveWorkTitle(title: string | undefined, objective: string): string {
	if (title !== undefined && title.trim().length > 0) {
		return title.trim();
	}
	const normalizedObjective = objective.trim().replace(/\s+/g, " ");
	if (normalizedObjective.length === 0) {
		return "Khala Work";
	}
	return `Khala Work: ${normalizedObjective.slice(0, 60)}`;
}

function validateWork(work: KhalaWork): string[] {
	const errors: string[] = [];
	for (const [label, value] of [
		["objective", work.objective],
		["scope", work.scope],
	] as const) {
		if (value.trim().length === 0) {
			errors.push(`${label} is required`);
		}
	}
	for (const [label, values] of [
		["acceptance criteria", work.acceptanceCriteria],
		["plan", work.plan],
		["validation", work.validation],
	] as const) {
		if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
			errors.push(`${label} must contain non-empty items`);
		}
	}
	if (work.constraints.some((value) => value.trim().length === 0)) {
		errors.push("constraints must contain non-empty items");
	}
	return errors;
}

const PARTICIPANT_HASH_LENGTH = 16;

function conclaveParticipantId(projectPath: string): string {
	return `conclave:${createHash("sha256").update(projectPath).digest("hex").slice(0, PARTICIPANT_HASH_LENGTH)}`;
}

function executorParticipantId(executionId: string): string {
	return `executor:${executionId}`;
}

export {
	admissionResult,
	admittedSubmissionState,
	conclaveParticipantId,
	deriveWorkTitle,
	ensureMission,
	executorParticipantId,
	isKhalaWorkDraft,
	isProjectTrusted,
	launchedResult,
	prepareExecutionLaunch,
	queueWork,
	readLatestWorkDraft,
	rejectedAdmission,
	rejectedWorkLaunch,
	toKhalaWork,
	validateWork,
};
