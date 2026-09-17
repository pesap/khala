import { nanoid } from "nanoid";
import type { ArchivePort } from "./archive.js";
import type { ActionInput, CommandMeta, Execution, Signal, WorkView } from "./model.js";
import type { OperationContext } from "./ports.js";
import { ArchiveCore } from "./service-archive-core.js";
import { type ServiceOptions } from "./service-contracts.js";
import { verdictEffects } from "./service-dispatch-policy.js";
import type { ServiceExecution } from "./service-execution.js";
import {
	correctionCountAvailable,
	type OracleInputs,
	type VerdictDecision,
	type VerdictTransition,
	verdictSignalMatches,
	workMaxCorrections,
} from "./service-foundation-policy.js";
import { isOracleInputReady, readDecision } from "./service-lifecycle-policy.js";
import { providerEvidenceAllowsReady } from "./service-provider-readiness.js";
import { handoffIsReady, nextCorrectionCount, verdictTransitions } from "./service-runtime-policy.js";
import { oracleEffect, requiredNonBlank, requiredText } from "./service-state-policy.js";

export class ServiceDecisions {
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly getOptions: () => ServiceOptions;
	private readonly execution: Pick<ServiceExecution, "start">;
	private readonly validateHandoffSource: (
		work: WorkView,
		execution: Execution,
		operation?: OperationContext,
	) => Promise<void>;

	constructor(input: {
		archive: ArchivePort;
		core: ArchiveCore;
		getOptions: () => ServiceOptions;
		execution: Pick<ServiceExecution, "start">;
		validateHandoffSource: (work: WorkView, execution: Execution, operation?: OperationContext) => Promise<void>;
	}) {
		this.archive = input.archive;
		this.core = input.core;
		this.getOptions = input.getOptions;
		this.execution = input.execution;
		this.validateHandoffSource = input.validateHandoffSource;
	}

	async runOracle(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
		_operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		const { mission } = this.requireOracleInputs(work);
		const options = this.getOptions();
		this.core.validateModel("oracle", options.oracleModel, options.oracleThinking);
		const subject = requiredNonBlank(requiredText(input?.subject, "subject"), "subject");
		return work.oraclePending === undefined ? this.queueOracle(work, meta, mission.missionId, subject) : work;
	}

	private queueOracle(work: WorkView, meta: CommandMeta, missionId: string, subject: string): WorkView {
		const executionId = this.core.requireExecution(work).executionId;
		const pending = {
			requestId: nanoid(),
			subject,
			missionId,
			executionId,
			signalId: requiredText(work.lastSignal?.signalId, "ready Signal"),
			headCommit: requiredText(work.reviewRequest?.headCommit, "review head"),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			oraclePending: pending,
			nextAction: "Oracle review is queued; Conclave will be woken with the result.",
		};
		return this.core.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId,
			executionId,
			payload: pending,
			projection: next,
			summary: "Oracle review queued.",
			effects: [oracleEffect(work.workId, next.revision, pending)],
		}).projection;
	}

	requireOracleInputs(work: WorkView): OracleInputs {
		if (isOracleInputReady(work)) return { mission: work.mission, reviewRequest: work.reviewRequest };
		throw this.core.error(
			"invalid-state",
			"Oracle review requires a ready Signal and review request.",
			false,
			"Wait for Executor handoff evidence.",
		);
	}

	async verdict(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		const execution = this.core.requireExecution(work);
		this.requireVerdictExecution(execution);
		const signal = work.lastSignal;
		const decision = readDecision(input);
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const signalId = requiredNonBlank(requiredText(input?.signalId, "signalId"), "signalId");
		this.requireVerdictSignal(execution, signal, decision, signalId);
		this.requireCorrectionAllowance(work, decision);
		await this.validateHandoffDecision(decision, work, execution, operation);
		const transition = this.verdictTransition(work, execution, signal, decision);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: transition.state,
			missionState: transition.missionState,
			lastSignal: transition.lastSignal,
			execution: transition.execution,
			correctionCount: nextCorrectionCount(work, decision),
			nextAction: transition.nextAction,
		};
		const result = this.core.append({
			meta,
			kind: "verdict",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: {
				decision,
				reason,
				signalId,
				executionId: execution.executionId,
			},
			projection: next,
			summary: `Conclave Verdict: ${decision}.`,
			effects: verdictEffects(work.workId, next.revision, decision, transition.execution),
		});
		return this.finishVerdict(decision, result.projection, meta);
	}

	private async finishVerdict(decision: VerdictDecision, work: WorkView, meta: CommandMeta): Promise<WorkView> {
		if (decision !== "replace") return work;
		return this.replaceVerdictExecution(work, meta);
	}

	private async validateHandoffDecision(
		decision: VerdictDecision,
		work: WorkView,
		execution: Execution,
		operation: OperationContext | undefined,
	): Promise<void> {
		if (decision === "handoff") await this.validateHandoffSource(work, execution, operation);
	}

	private requireCorrectionAllowance(work: WorkView, decision: VerdictDecision): void {
		if (decision !== "replace") return;
		const limit = workMaxCorrections(work, this.getOptions());
		if (correctionCountAvailable(work, limit)) return;
		throw this.core.error(
			"budget-exhausted",
			"The Work correction allowance is exhausted.",
			false,
			"Ask the User to authorize a larger correction allowance or stop the Work.",
		);
	}

	private requireVerdictExecution(execution: Execution): void {
		if (execution.state === "running" || execution.state === "blocked") return;
		throw this.core.error(
			"invalid-state",
			"The current Execution is not awaiting a Verdict.",
			false,
			"Wait for a current Executor Signal.",
		);
	}

	private requireVerdictSignal(
		execution: Execution,
		signal: Signal | undefined,
		decision: VerdictDecision,
		signalId: string,
	): void {
		this.requireBudgetVerdict(decision, execution);
		const budgetExhausted = execution.blockReason === "budget-exhausted";
		if (verdictSignalMatches(execution, signal, signalId, budgetExhausted)) return;
		throw this.core.error(
			"invalid-state",
			budgetExhausted
				? "A budget-exhausted Verdict must use signalId budget-exhausted."
				: "The Verdict must reference the current Signal.",
			false,
			"Read the latest Signal before deciding.",
		);
	}

	private requireBudgetVerdict(decision: VerdictDecision, execution: Execution): void {
		if (decision !== "continue" || execution.blockReason !== "budget-exhausted") return;
		throw this.core.error(
			"budget-exhausted",
			"The Execution has exhausted its token allowance.",
			false,
			"Replace the Execution or amend the Work budget before continuing.",
		);
	}

	private verdictTransition(
		work: WorkView,
		execution: Execution,
		signal: Signal | undefined,
		decision: VerdictDecision,
	): VerdictTransition {
		if (decision === "handoff") this.requireHandoff(work, execution, signal);
		return verdictTransitions[decision](work, execution);
	}

	private requireHandoff(work: WorkView, execution: Execution, signal: Signal | undefined): void {
		if (handoffIsReady(work, execution, signal, this.handoffProviderEvidence(work))) return;
		throw this.core.error(
			"invalid-state",
			"Handoff requires a ready Signal and review request.",
			false,
			"Create review evidence before handoff.",
		);
	}

	private handoffProviderEvidence(work: WorkView): boolean {
		const request = work.reviewRequest;
		if (request === undefined) return false;
		return providerEvidenceAllowsReady(this.archive, work, request);
	}

	private async replaceVerdictExecution(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		const replacement = await this.execution.start(work, {
			...meta,
			commandId: `${meta.commandId}:replacement`,
			commandFingerprint: undefined,
			expectedWorkRevision: work.revision,
		});
		this.archive.updateCommandProjection(meta.commandId, replacement);
		return replacement;
	}
}
