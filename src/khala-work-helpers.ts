// biome-ignore-all lint/style/noExcessiveLinesPerFile: Work validation and lifecycle helper projections share the same authoritative input boundary.
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { appendArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	activeCoordinationHolds,
	listCoordinationRecords,
	projectCoordinations,
	readCurrentMission,
	readMandate,
} from "./khala-archive-projections.js";
import type { SubmissionSnapshot } from "./khala-conclave-storage.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { formatError } from "./khala-error.js";
import { listLearningRecords } from "./khala-learning.js";
import type { KhalaWork, KhalaWorkSubmission, LearningRecord, MandateRecord, MissionRecord } from "./khala-model.js";
import { KhalaWorkEntryStatus, KhalaWorkLaunchStatus, WorkSubmissionStatus } from "./khala-model.js";
import { materializeMissingRetrySuccessor, materializeReviewRequestedSuccessor } from "./khala-verdict-recovery.js";
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
): PreparedExecutionLaunch {
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
	let currentProjection = readCurrentMission(context.cwd, workId, projectTrusted);
	if (currentProjection?.state === "finished") {
		materializeReviewRequestedSuccessor(context.cwd, projectTrusted, workId);
		currentProjection = readCurrentMission(context.cwd, workId, projectTrusted);
	}
	if (currentProjection?.state === "retry-pending" && currentProjection.terminalVerdict !== undefined) {
		materializeMissingRetrySuccessor(context.cwd, projectTrusted, currentProjection.terminalVerdict);
		currentProjection = readCurrentMission(context.cwd, workId, projectTrusted);
	}
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
	assignedParticipantId?: string;
	readSubmission?: (projectPath: string, workId: string, projectTrusted?: boolean) => SubmissionSnapshot | undefined;
}): MissionRecord {
	// The create/reuse/reject decision happens inside the work lock against the current Archive
	// state, so a concurrent retry or launch cannot reuse a superseded Mission or create a duplicate.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The locked decision re-verifies submission, mandate, and Mission state before acting.
	return withArchiveLock(input.projectPath, input.projectTrusted, () => {
		if (input.readSubmission !== undefined) {
			const current = input.readSubmission(input.projectPath, input.workId, input.projectTrusted);
			if (
				current === undefined ||
				current.submission.status !== WorkSubmissionStatus.admitted ||
				current.submission.mandateId !== input.mandate.mandateId
			) {
				throw new Error(`Work Submission ${input.workId} changed before Mission materialization.`);
			}
		}
		const currentMandate = readMandate(input.projectPath, input.mandate.mandateId, input.projectTrusted);
		if (currentMandate === undefined) {
			throw new Error(`Mandate ${input.mandate.mandateId} is unavailable for Work ${input.workId}.`);
		}
		const current = readCurrentMission(input.projectPath, input.workId, input.projectTrusted);
		if (current?.state === "retry-pending") {
			throw new Error(`Mission ${current.mission.missionId} has an incomplete Retry; recovery is required.`);
		}
		if (current !== undefined && current.state !== "current") {
			throw new Error(`Mission ${current.mission.missionId} is ${current.state} and cannot be materialized.`);
		}
		if (current !== undefined) {
			return current.mission;
		}
		const missionId = nanoid();
		const mission: MissionRecord = {
			missionId,
			workId: input.workId,
			mandateId: currentMandate.mandateId,
			assignment: currentMandate.terms,
			assignedParticipantId: input.assignedParticipantId ?? `executor:${missionId}`,
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
	const work: KhalaWork = {
		title: deriveWorkTitle(params.title, params.objective),
		objective: params.objective.trim(),
		context: params.context?.trim() ?? "",
		scope: params.scope.trim(),
		acceptanceCriteria: params.acceptanceCriteria.map((value) => value.trim()),
		constraints: params.constraints.map((value) => value.trim()),
		plan: params.plan.map((value) => value.trim()),
		validation: params.validation.map((value) => value.trim()),
	};
	if (params.costBudget !== undefined) {
		const costBudget: { conclaveMaxCostUsdPerTurn?: number; executorMaxCostUsdPerTurn?: number } = {};
		if (params.costBudget.conclaveMaxCostUsdPerTurn !== undefined) {
			costBudget.conclaveMaxCostUsdPerTurn = params.costBudget.conclaveMaxCostUsdPerTurn;
		}
		if (params.costBudget.executorMaxCostUsdPerTurn !== undefined) {
			costBudget.executorMaxCostUsdPerTurn = params.costBudget.executorMaxCostUsdPerTurn;
		}
		return { ...work, costBudget };
	}
	return work;
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

function launchHold(projectPath: string, workId: string, missionId: string, projectTrusted: boolean) {
	const active = activeCoordinationHolds(projectPath, projectTrusted).find(
		(hold) => hold.workId === workId && hold.missionId === missionId,
	);
	if (active !== undefined) {
		return active;
	}
	const records = listCoordinationRecords(projectPath, projectTrusted);
	const latestRelevant = [...records]
		.reverse()
		.find((record) => record.relation === "dependency" && record.workId === workId);
	if (latestRelevant?.phase !== "resolution" || latestRelevant.resolution !== "terminal-failure") {
		return;
	}
	const coordination = projectCoordinations(projectPath, projectTrusted).find(
		(candidate) => candidate.coordinationId === latestRelevant.coordinationId,
	);
	const current = readCurrentMission(projectPath, workId, projectTrusted);
	if (coordination === undefined || current?.mission.missionId !== missionId) {
		return;
	}
	return { coordination, workId, missionId };
}

function rejectedWorkLaunch(message: string): never {
	throw new Error(message);
}

function rejectedAdmission(message: string): never {
	throw new Error(message);
}

function admissionResult(mandate: MandateRecord): KhalaAdmissionResult {
	return {
		content: [
			{
				type: "text",
				text: [
					`Work ID: ${mandate.workId}`,
					`Mandate ID: ${mandate.mandateId} revision ${mandate.revision}`,
					"Status: admitted",
					"Executor: not assigned; Mission launch is pending.",
				].join("\n"),
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
				text: [
					`Work ID: ${input.workId}`,
					`Mission ID: ${input.mission.missionId}`,
					`Execution ID: ${input.executionId}`,
					`Executor: ${input.executorName}`,
					`Status: launched in ${input.destination}`,
				].join("\n"),
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

function queueWork(input: {
	pi: ExtensionAPI;
	work: KhalaWork;
	explicitWorkId: string | undefined;
	signal: AbortSignal | undefined;
	context: ExtensionContext;
	dependencies: KhalaWorkDependencies;
}): Promise<KhalaWorkLaunchResult> {
	// The editor command still supplies a draft ID when one exists, but direct
	// LLM tool calls must remain usable without session-local Work state.
	const { pi, work, explicitWorkId, signal, context, dependencies } = input;
	const workId = explicitWorkId?.trim() || readLatestWorkDraft(context)?.workId || nanoid();
	return dependencies
		.submitWork({ workId, projectPath: context.cwd, work, projectTrusted: isProjectTrusted(context), signal })
		.then(
			(queued): KhalaWorkLaunchResult => {
				pi.appendEntry(KhalaEntryType.work, {
					status: KhalaWorkEntryStatus.queued,
					workId,
					title: work.title,
					archivePath: queued.archivePath,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: [
								`Work "${work.title}" persisted and queued for Conclave review.`,
								`Work ID: ${workId}`,
								"Conclave processing was scheduled; admission and launch remain pending.",
							].join("\n"),
						},
					],
					details: {
						status: KhalaWorkLaunchStatus.queued,
						workId,
						archivePath: queued.archivePath,
					},
				};
			},
			(error: unknown): never => {
				throw new Error(`Work submission failed: ${formatError(error)}`);
			},
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Work validation reports all contract errors in one actionable result.
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
	if (work.costBudget !== undefined) {
		if (
			work.costBudget.conclaveMaxCostUsdPerTurn === undefined &&
			work.costBudget.executorMaxCostUsdPerTurn === undefined
		) {
			errors.push("cost budget must configure at least one actor");
		}
		for (const [label, value] of [
			["Conclave cost budget", work.costBudget.conclaveMaxCostUsdPerTurn],
			["Executor cost budget", work.costBudget.executorMaxCostUsdPerTurn],
		] as const) {
			if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
				errors.push(`${label} must be finite and greater than zero`);
			}
		}
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
	launchHold,
	prepareExecutionLaunch,
	queueWork,
	readLatestWorkDraft,
	rejectedAdmission,
	rejectedWorkLaunch,
	toKhalaWork,
	validateWork,
};
