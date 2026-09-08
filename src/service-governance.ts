import { nanoid } from "nanoid";
import { type ActionInput, type CommandMeta, type Mission, type WorkView } from "./model.js";
import { schedulerEffect } from "./provider-observation-policy.js";
import { ArchiveCore } from "./service-archive-core.js";
import { mergeTermChanges, reviewFeedback } from "./service-dispatch-policy.js";
import { type ReviewStatus } from "./service-foundation-policy.js";
import { readOptionalActionTextList, readReviewStatus, reviewProjection } from "./service-lifecycle-policy.js";
import { reviewEffects, reviewFeedbackDelivery } from "./service-runtime-policy.js";
import {
	amendedMissionSpecificity,
	hasActiveExecution,
	missionSpecificity,
	requiredNonBlank,
	requiredText,
} from "./service-state-policy.js";

export class ServiceGovernance {
	private readonly core: ArchiveCore;

	constructor(core: ArchiveCore) {
		this.core = core;
	}

	requestInput(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "conclave");
		this.requirePreAdmissionWork(work, "User input can only be requested before admission.");
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const missing = readOptionalActionTextList(input?.missing, "missing");
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "needs-input",
			nextAction: `User input required: ${reason}`,
		};
		return this.core.append({
			meta,
			kind: "error",
			workId: work.workId,
			payload: { reason, missing },
			projection: next,
			summary: "Conclave requested additional User input.",
		}).projection;
	}

	amendTerms(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "user");
		this.requirePreAdmissionWork(work, "Work terms can only change before admission.");
		const terms = mergeTermChanges(work.terms, input, false);
		const specificity = amendedMissionSpecificity(
			work.missionSpecificity ?? { status: "explicit", missing: [] },
			input,
		);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: specificity.missing.length === 0 ? "submitted" : "needs-input",
			terms,
			missionSpecificity: specificity,
			nextAction:
				specificity.missing.length === 0
					? "Conclave admission is pending."
					: `User input required: ${specificity.missing.join(", ")}.`,
		};
		return this.core.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			payload: { change: "terms", terms },
			projection: next,
			summary: "Work terms amended before Mission admission.",
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	amendMission(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "conclave");
		const predecessor = this.requireAmendableMission(work);
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const evidence = readOptionalActionTextList(input?.evidence, "evidence");
		const assignment = mergeTermChanges(work.terms, input, true);
		const successor: Mission = {
			missionId: nanoid(),
			workId: work.workId,
			assignment,
			specificity: missionSpecificity(assignment),
			mandateRevision: predecessor.mandateRevision + 1,
			createdAt: new Date().toISOString(),
			predecessorMissionId: predecessor.missionId,
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "queued",
			terms: assignment,
			missionSpecificity: undefined,
			mission: successor,
			missionState: "admitted",
			execution: undefined,
			reviewRequest: undefined,
			lastSignal: undefined,
			lastObservation: undefined,
			providerOutcome: undefined,
			lastValidation: undefined,
			lastError: undefined,
			nextAction: "Waiting for budget or project concurrency.",
			queuedSequence: 0,
		};
		return this.core.append({
			meta,
			kind: "mission-change",
			workId: work.workId,
			missionId: successor.missionId,
			payload: { predecessorMissionId: predecessor.missionId, successor, reason, evidence, disposition: "superseded" },
			projection: next,
			summary: `Mission ${predecessor.missionId} was superseded by ${successor.missionId}.`,
			evidenceRefs: evidence,
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	admit(work: WorkView, meta: CommandMeta): WorkView {
		this.core.requireActor(meta, "conclave");
		if (work.state !== "submitted") {
			throw this.core.error(
				"invalid-state",
				"Only submitted Work can be admitted.",
				false,
				"Inspect the current Work state.",
			);
		}
		const mission: Mission = {
			missionId: nanoid(),
			workId: work.workId,
			assignment: work.terms,
			specificity: work.missionSpecificity ?? missionSpecificity(work.terms),
			mandateRevision: 1,
			createdAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "queued",
			stopReason: undefined,
			mission,
			missionSpecificity: undefined,
			missionState: "admitted",
			lastError: undefined,
			nextAction: "Waiting for budget or project concurrency.",
		};
		return this.core.append({
			meta,
			kind: "mission",
			workId: work.workId,
			missionId: mission.missionId,
			payload: mission,
			projection: next,
			summary: `Mission ${mission.missionId} admitted.`,
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	async recordReview(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.core.requireActor(meta, "user");
		this.requireReviewState(work);
		const status = readReviewStatus(input);
		const feedback = reviewFeedback(input);
		this.requireReviewFeedback(status, feedback);
		const next = reviewProjection(work, status);
		const feedbackDelivery = reviewFeedbackDelivery(work, status, next.revision, feedback);
		return this.core.append({
			meta,
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { status, feedback, deliveryId: feedbackDelivery?.effectId },
			projection: next,
			summary: `User review recorded: ${status}.`,
			evidenceRefs: feedback,
			effects: reviewEffects(work, next.revision, feedbackDelivery),
		}).projection;
	}

	private requirePreAdmissionWork(work: WorkView, message: string): void {
		if (work.mission !== undefined || (work.state !== "submitted" && work.state !== "needs-input"))
			throw this.core.error("invalid-state", message, false, "Inspect the current Work state.");
	}

	private requireAmendableMission(work: WorkView): Mission {
		const mission = work.mission;
		if (mission === undefined)
			throw this.core.error(
				"invalid-state",
				"Only an inactive Mission can be amended.",
				false,
				"Admit the Work first.",
			);
		if (["succeeded", "stopped"].includes(work.state))
			throw this.core.error(
				"invalid-state",
				"Only an inactive Mission can be amended.",
				false,
				"Inspect the terminal Work.",
			);
		if (hasActiveExecution(work))
			throw this.core.error(
				"invalid-state",
				"Only an inactive Mission can be amended.",
				false,
				"End the current Execution before amending the Mission.",
			);
		return mission;
	}

	private requireReviewState(
		work: WorkView,
	): asserts work is WorkView & { reviewRequest: NonNullable<WorkView["reviewRequest"]> } {
		if (work.state === "awaiting-review" && work.reviewRequest !== undefined) return;
		throw this.core.error("invalid-state", "Work is not awaiting a review.", false, "Wait for a handoff Verdict.");
	}

	private requireReviewFeedback(status: ReviewStatus, feedback: readonly string[]): void {
		if (status !== "changes-requested" || feedback.length > 0) return;
		throw this.core.error(
			"invalid-input",
			"Review feedback is required when changes are requested.",
			false,
			"Provide at least one concrete feedback item.",
		);
	}
}
