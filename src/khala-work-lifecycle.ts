import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { withArchiveLock } from "./khala-archive.js";
import { readCurrentMission, readMandate } from "./khala-archive-projections.js";
import { listLearningRecords } from "./khala-learning.js";
import { type MandateRecord, WorkSubmissionStatus } from "./khala-model.js";
import type {
	KhalaAdmissionResult,
	KhalaAdmitWorkInput,
	KhalaLaunchExecutionInput,
	KhalaWorkDependencies,
	KhalaWorkLaunchResult,
} from "./khala-work.js";
import { admitWithinLock } from "./khala-work-admission.js";
import { launchFromConclave } from "./khala-work-executor.js";
import {
	admissionResult,
	admittedSubmissionState,
	conclaveParticipantId,
	ensureMission,
	isProjectTrusted,
	rejectedAdmission,
	rejectedWorkLaunch,
	validateWork,
} from "./khala-work-helpers.js";

function admitWork(
	params: KhalaAdmitWorkInput,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): KhalaAdmissionResult {
	if (!dependencies.isDedicatedConclaveSession(context)) {
		return rejectedAdmission("Only the dedicated project Conclave may admit Work.");
	}
	const projectTrusted = isProjectTrusted(context);
	const snapshot = dependencies.getSubmission(context.cwd, params.workId, projectTrusted);
	if (snapshot === undefined) {
		return rejectedAdmission(`No authoritative Work Submission exists for ID ${params.workId}.`);
	}
	const { submission } = snapshot;
	const validationErrors = validateWork(submission.work);
	if (validationErrors.length > 0) {
		return rejectedAdmission(`Work cannot be admitted:\n- ${validationErrors.join("\n- ")}`);
	}
	const learning = listLearningRecords(context.cwd, params.workId, projectTrusted);
	if (submission.work.context.trim().length === 0 && learning.length === 0) {
		return rejectedAdmission(
			"Work context is missing; sufficient Work-scoped Observer Learning is required before admission.",
		);
	}
	if (submission.status === WorkSubmissionStatus.admitted && submission.mandateId !== undefined) {
		const existing = readMandate(context.cwd, submission.mandateId, projectTrusted);
		if (existing !== undefined) {
			return admissionResult(existing);
		}
		return rejectedAdmission("The Archive records an admitted Work whose Mandate is missing; recovery is required.");
	}
	if (submission.status === WorkSubmissionStatus.rejected) {
		return rejectedAdmission("A rejected Work Submission cannot be admitted.");
	}
	const mandateId = nanoid();
	const mandate: MandateRecord = {
		mandateId,
		workId: submission.workId,
		revision: 1,
		sourceSubmissionRecordId: snapshot.recordId,
		terms: submission.work,
		admittedByParticipantId: conclaveParticipantId(context.cwd),
		admittedAt: new Date().toISOString(),
	};
	const admittedSubmission = admittedSubmissionState(submission, mandateId);
	return withArchiveLock(context.cwd, projectTrusted, () =>
		admitWithinLock({ context, dependencies, params, snapshot, mandate, admittedSubmission, projectTrusted }),
	);
}

function materializeMission(
	workId: string,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): KhalaWorkLaunchResult {
	const projectTrusted = isProjectTrusted(context);
	const snapshot = dependencies.getSubmission(context.cwd, workId, projectTrusted);
	if (snapshot === undefined) {
		return rejectedWorkLaunch(`No authoritative Work Submission exists for ID ${workId}.`);
	}
	if (snapshot.submission.status !== WorkSubmissionStatus.admitted || snapshot.submission.mandateId === undefined) {
		return rejectedWorkLaunch(`Work Submission ${workId} must be admitted under a Mandate before materialization.`);
	}
	const mandate = readMandate(context.cwd, snapshot.submission.mandateId, projectTrusted);
	if (mandate === undefined || mandate.workId !== workId) {
		return rejectedWorkLaunch(`Mandate ${snapshot.submission.mandateId} is unavailable for Work ${workId}.`);
	}
	const current = readCurrentMission(context.cwd, workId, projectTrusted);
	if (current !== undefined && current.state !== "current") {
		return rejectedWorkLaunch(`Mission ${current.mission.missionId} is ${current.state} and cannot be materialized.`);
	}
	const mission = ensureMission({
		projectPath: context.cwd,
		projectTrusted,
		workId,
		mandate,
		existingMission: current?.mission,
	});
	return {
		content: [{ type: "text", text: `Mission ${mission.missionId} materialized without an Executor.` }],
		details: {
			status: "materialized",
			workId,
			missionId: mission.missionId,
			mandateId: mission.mandateId,
		},
	};
}

function launchExecution(
	pi: ExtensionAPI,
	params: KhalaLaunchExecutionInput,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): Promise<KhalaWorkLaunchResult> {
	if (!dependencies.isDedicatedConclaveSession(context)) {
		return Promise.resolve(rejectedWorkLaunch("Only the dedicated project Conclave may launch an execution."));
	}
	if (params.mode === "materialize") {
		return Promise.resolve(materializeMission(params.workId, context, dependencies));
	}
	return launchFromConclave(pi, params.workId, context, dependencies);
}

export { admitWork, launchExecution };
