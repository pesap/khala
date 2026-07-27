import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendArchiveRecords } from "./khala-archive.js";
import { readLatestMandate, readMandate } from "./khala-archive-projections.js";
import type { SubmissionSnapshot } from "./khala-conclave-storage.js";
import { type KhalaWorkSubmission, type MandateRecord, WorkSubmissionStatus } from "./khala-model.js";
import type { KhalaAdmissionResult, KhalaAdmitWorkInput, KhalaWorkDependencies } from "./khala-work.js";
import { admissionResult, admittedSubmissionState } from "./khala-work-helpers.js";

function admitWithinLock(input: {
	context: ExtensionContext;
	dependencies: KhalaWorkDependencies;
	params: KhalaAdmitWorkInput;
	snapshot: SubmissionSnapshot;
	mandate: MandateRecord;
	admittedSubmission: KhalaWorkSubmission;
	projectTrusted: boolean;
}): KhalaAdmissionResult {
	const { context, dependencies, params, snapshot, mandate, admittedSubmission, projectTrusted } = input;
	const current = dependencies.getSubmission(context.cwd, params.workId, projectTrusted);
	if (current?.submission.status === WorkSubmissionStatus.admitted && current.submission.mandateId !== undefined) {
		const existing = readMandate(context.cwd, current.submission.mandateId, projectTrusted);
		if (existing !== undefined) {
			return admissionResult(existing);
		}
		throw new Error("The Archive records an admitted Work whose Mandate is missing; recovery is required.");
	}
	if (
		current?.recordId !== snapshot.recordId &&
		current?.submission.status !== WorkSubmissionStatus.queued &&
		current?.submission.status !== WorkSubmissionStatus.reviewing
	) {
		throw new Error("The Work Submission changed during admission; retry against the current Archive state.");
	}
	const existingMandate = readLatestMandate(context.cwd, params.workId, projectTrusted);
	if (existingMandate !== undefined) {
		if (
			current?.submission.status === WorkSubmissionStatus.admitted &&
			current.submission.mandateId === existingMandate.mandateId
		) {
			return admissionResult(existingMandate);
		}
		if (
			current?.submission.status === WorkSubmissionStatus.queued ||
			current?.submission.status === WorkSubmissionStatus.reviewing
		) {
			const admitted = admittedSubmissionState(current.submission, existingMandate.mandateId);
			appendArchiveRecords(
				context.cwd,
				[{ schemaVersion: 2, type: "submission", workId: admitted.workId, payload: admitted }],
				projectTrusted,
			);
			return admissionResult(existingMandate);
		}
		throw new Error("A Mandate exists without a compatible current Work Submission.");
	}
	appendArchiveRecords(
		context.cwd,
		[
			{ schemaVersion: 2, type: "mandate", workId: mandate.workId, payload: mandate },
			{ schemaVersion: 2, type: "submission", workId: admittedSubmission.workId, payload: admittedSubmission },
		],
		projectTrusted,
	);
	return admissionResult(mandate);
}

export { admitWithinLock };
