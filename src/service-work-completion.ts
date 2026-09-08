import type { ActionInput, CommandMeta, RecoveryUpdate, WorkView } from "./model.js";
import { schedulerEffect } from "./provider-observation-policy.js";
import type { ArchiveCore } from "./service-archive-core.js";
import { lifecycleEffects, requireOutcomeEvidence } from "./service-dispatch-policy.js";
import { failedExecution, isCancelledWork, isTerminalWork, workFailure } from "./service-foundation-policy.js";
import { succeededWork } from "./service-lifecycle-policy.js";
import { isDispatchBudgetAttention, requiredNonBlank, requiredText } from "./service-state-policy.js";

export class WorkCompletion {
	private readonly core: ArchiveCore;

	constructor(core: ArchiveCore) {
		this.core = core;
	}

	recordOutcome(work: WorkView, meta: CommandMeta): WorkView {
		this.core.requireActor(meta, "conclave");
		const evidence = requireOutcomeEvidence(work);
		const next = succeededWork(work);
		return this.core.append({
			meta,
			kind: "outcome",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { reviewRequestId: evidence.reviewRequest.providerId, mergeEvidence: evidence.providerOutcome.summary },
			projection: next,
			summary: "Provider-confirmed merge accepted as the Work Outcome.",
			effects: lifecycleEffects(work.workId, next.revision, next.execution, undefined, false),
		}).projection;
	}

	failWork(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireFailureActor(meta);
		this.requireNonTerminalWork(work);
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const failure = workFailure(reason);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "stopped",
			stopReason: "failed",
			execution: failedExecution(work.execution),
			observer: undefined,
			observerInFlight: false,
			lastError: failure,
			nextAction: "Work failed by explicit decision.",
		};
		return this.core.append({
			meta,
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { reason },
			projection: next,
			summary: "Work failed by explicit User or Conclave decision.",
			effects: lifecycleEffects(work.workId, next.revision, next.execution, work.observer, false),
		}).projection;
	}

	renameWork(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "user");
		this.requireRenameableWork(work);
		const title = requiredNonBlank(requiredText(input?.title, "title"), "title");
		this.requireNewTitle(work, title);
		return this.core.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { change: "title", previousTitle: work.terms.title, title },
			projection: { ...work, revision: work.revision + 1, terms: { ...work.terms, title } },
			summary: `Work title renamed to ${title}.`,
		}).projection;
	}

	amendBudget(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.core.requireActor(meta, "user");
		const maxTokens = this.requireBudgetChange(work, input);
		const attention = isDispatchBudgetAttention(work.lastError);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			terms: { ...work.terms, maxTokens },
			budget: { ...work.budget, maxTokens },
			lastError: attention ? undefined : work.lastError,
			nextAction: attention ? "Work dispatch is pending." : work.nextAction,
		};
		return this.core.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			payload: { previousMaxTokens: work.budget.maxTokens, maxTokens },
			projection: next,
			summary: `Work token cap amended to ${maxTokens}.`,
			effects: work.state === "queued" ? [schedulerEffect(work.workId, next.revision)] : undefined,
		}).projection;
	}

	recoverStopped(work: WorkView, meta: CommandMeta, onRecoveryUpdate?: (update: RecoveryUpdate) => void): WorkView {
		this.core.requireActor(meta, "user");
		onRecoveryUpdate?.({ stage: "checking", message: "Preparing the cancelled Work for recovery." });
		this.requireCancelledWork(work);
		onRecoveryUpdate?.({ stage: "finishing", message: "Returning the recovered Work to admission." });
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "submitted",
			stopReason: undefined,
			lastError: undefined,
			mission: undefined,
			missionState: undefined,
			preparation: undefined,
			execution: undefined,
			observer: undefined,
			observerInFlight: false,
			reviewRequest: undefined,
			lastSignal: undefined,
			lastObservation: undefined,
			providerOutcome: undefined,
			lastValidation: undefined,
			nextAction: "Recovered Work is pending Conclave admission.",
		};
		return this.core.append({
			meta,
			kind: "mission-change",
			workId: work.workId,
			missionId: work.mission?.missionId,
			payload: { action: "recover", previousState: work.state, stopReason: work.stopReason },
			projection: next,
			summary: "Stopped Work was recovered and returned to admission.",
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	cancel(work: WorkView, meta: CommandMeta): WorkView {
		this.core.requireActor(meta, "user");
		if (["succeeded", "stopped"].includes(work.state))
			throw this.core.error(
				"invalid-state",
				"Terminal Work cannot be cancelled.",
				false,
				"Inspect the terminal Work evidence.",
			);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "stopped",
			stopReason: "cancelled",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "stopped", blockReason: undefined, endedAt: new Date().toISOString() },
			observer: undefined,
			observerInFlight: false,
			oraclePending: undefined,
			nextAction: "Work cancelled by the User.",
		};
		return this.core.append({
			meta,
			kind: "observation",
			workId: work.workId,
			executionId: work.execution?.executionId,
			payload: { action: "cancel" },
			projection: next,
			summary: "Work cancelled by explicit User decision.",
			effects: lifecycleEffects(work.workId, next.revision, next.execution, work.observer, false),
		}).projection;
	}

	private requireFailureActor(meta: CommandMeta): void {
		if (meta.actor === "user" || meta.actor === "conclave") return;
		throw this.core.error(
			"forbidden",
			"Only User or Conclave can fail Work explicitly.",
			false,
			"Use an authorized actor.",
		);
	}

	private requireNonTerminalWork(work: WorkView): void {
		if (!isTerminalWork(work)) return;
		throw this.core.error(
			"invalid-state",
			"Terminal Work cannot be failed again.",
			false,
			"Inspect the existing terminal Outcome.",
		);
	}

	private requireRenameableWork(work: WorkView): void {
		if (work.state !== "succeeded") return;
		throw this.core.error(
			"invalid-state",
			"Succeeded Work cannot be renamed.",
			false,
			"Rename an active or failed Work instead.",
		);
	}

	private requireNewTitle(work: WorkView, title: string): void {
		if (title !== work.terms.title) return;
		throw this.core.error(
			"invalid-input",
			"The new Work title matches the current title.",
			false,
			"Choose a different title.",
		);
	}

	private requireBudgetChange(work: WorkView, input: ActionInput | undefined): number {
		const maxTokens = input?.maxTokens;
		this.requirePositiveBudget(maxTokens);
		if (maxTokens < work.budget.reservedTokens + work.budget.consumedTokens)
			throw this.core.error(
				"invalid-input",
				"The amended cap cannot be below reserved or consumed tokens.",
				false,
				"Choose a cap that covers current reservations and consumption.",
			);
		return maxTokens;
	}

	private requirePositiveBudget(maxTokens: number | undefined): asserts maxTokens is number {
		if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) return;
		throw this.core.error(
			"invalid-input",
			"maxTokens must be a positive integer.",
			false,
			"Supply a larger positive Work budget.",
		);
	}

	private requireCancelledWork(work: WorkView): void {
		if (isCancelledWork(work)) return;
		throw this.core.error(
			"invalid-state",
			"Only Work stopped by cancellation can be recovered.",
			false,
			"Inspect the Work state before recovering it.",
		);
	}
}
