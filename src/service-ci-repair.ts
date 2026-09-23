import type { ArchivePort, PendingArchiveEffect } from "./archive.js";
import { InvocationLaunchError } from "./dispatch.js";
import type { ActionInput, CommandMeta, ProviderCheck, ProviderCiObservation, WorkView } from "./model.js";
import type { AgentRuntimePort, OperationContext, RuntimeBinding } from "./ports.js";
import { ArchiveCore } from "./service-archive-core.js";
import {
	archiveHasAuthorization,
	archiveHasExecutionAuthorization,
	currentCiFailure,
} from "./service-ci-repair-archive.js";
import { ciRepairCompletionFailure } from "./service-ci-repair-completion.js";
import {
	type AuthorizationPlan,
	authorizationCommandIdForWork,
	authorizationStillTargetsWork,
	type CiRepairAuthorization,
	type CurrentCiFailure,
	ciRepairPrompt,
	currentFailureScope,
	currentReviewMatches,
	currentSignalAllowsRepair,
	currentValidationAllowsRepair,
	executionStartCommandId,
	hasExecutionAllowance,
	isAuthorizedExecution,
	isCurrentAuthorizedTurn,
	isCurrentConclaveReservation,
	isPreflightFailure,
	isUncertainExecutorInvocation,
	type Preflight,
	parseAuthorization,
	preflightFailure,
	requireObservationId,
	sameAuthorizationTarget,
	selectFailedChecks,
} from "./service-ci-repair-policy.js";
import {
	appendCiRepairStatus,
	appendStartedCiRepairStatus,
	hasCiRepairStatus,
	hasTerminalCiRepairStatus,
} from "./service-ci-repair-status.js";
import type { ExecutorRuntimeCoordinator } from "./service-executor-runtime.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { invocationAllowance, readEffectText, readEffectWorkId } from "./service-state-policy.js";
import { dispatchEligibility } from "./workflow-dispatch.js";

type StartedRepair = Readonly<{ work: WorkView; execution: NonNullable<WorkView["execution"]> }>;

export class ServiceCiRepair {
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly runtime: AgentRuntimePort;
	private readonly invocations: InvocationCoordinator;
	private readonly executorRuntime: ExecutorRuntimeCoordinator;
	private readonly enabled: boolean;
	private readonly activeRepairs = new Set<string>();

	constructor(input: {
		archive: ArchivePort;
		core: ArchiveCore;
		runtime: AgentRuntimePort;
		invocations: InvocationCoordinator;
		executorRuntime: ExecutorRuntimeCoordinator;
		enabled: boolean;
	}) {
		this.archive = input.archive;
		this.core = input.core;
		this.runtime = input.runtime;
		this.invocations = input.invocations;
		this.executorRuntime = input.executorRuntime;
		this.enabled = input.enabled;
	}

	canAuthorize(work: WorkView): boolean {
		return this.enabled && this.currentFailureCanBeAuthorized(work);
	}

	private currentFailureCanBeAuthorized(work: WorkView): boolean {
		const failure = currentCiFailure(this.archive, work, work.lastObservation?.observationId ?? "");
		return failure !== undefined && this.canAuthorizeFailure(work, failure);
	}

	async authorize(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
		operation?: OperationContext,
	): Promise<WorkView> {
		this.core.requireActor(meta, "conclave");
		if (!this.enabled)
			throw this.repairError(
				"CI repair is disabled.",
				"Opt in through enableCiRepair only after completing the required held-out evaluation.",
			);
		const plan = this.authorizationPlan(work, meta, input);
		if (plan === undefined) return this.core.inspectWork(work.workId);
		return this.confirmAuthorization(plan, meta, operation);
	}

	async processWake(effect: PendingArchiveEffect): Promise<void> {
		const authorization = this.readEffectAuthorization(effect);
		if (authorization === undefined) return;
		if (hasTerminalCiRepairStatus(this.archive, authorization) || this.blockDisabledWake(authorization)) return;
		await this.processAuthorization(authorization);
	}

	private blockDisabledWake(authorization: CiRepairAuthorization): boolean {
		if (this.enabled || hasCiRepairStatus(this.archive, authorization, "started")) return false;
		appendCiRepairStatus(
			this.core,
			this.archive,
			this.core.inspectWork(authorization.workId),
			authorization,
			"blocked",
			"CI repair was disabled before its authorized wake was processed.",
		);
		return true;
	}

	private authorizationPlan(
		work: WorkView,
		meta: CommandMeta,
		input: ActionInput | undefined,
	): AuthorizationPlan | undefined {
		const current = this.core.inspectWork(work.workId);
		this.core.checkRevision(current, meta);
		const observationId = requireObservationId(input);
		const failure = this.requireCurrentFailure(current, observationId);
		const authorizationId = authorizationCommandIdForWork(current, failure.record);
		if (this.hasAuthorizationFor(current, authorizationId)) return undefined;
		this.requireNoExistingExecutionAuthorization(current);
		this.requireAuthorizationCandidate(current, failure);
		const selectedChecks = selectFailedChecks(input, failure.failedChecks);
		const binding = current.execution?.pi;
		if (binding === undefined)
			throw this.repairError(
				"The current Execution has no runtime binding.",
				"Reconcile the current Executor runtime.",
			);
		return { work: current, failure, observationId, authorizationId, binding, selectedChecks };
	}

	private async confirmAuthorization(
		plan: AuthorizationPlan,
		meta: CommandMeta,
		operation?: OperationContext,
	): Promise<WorkView> {
		const runtimeState = await this.runtime.getState(plan.binding, operation);
		const current = this.core.inspectWork(plan.work.workId);
		this.core.checkRevision(current, meta);
		const refreshed = this.requireCurrentFailure(current, plan.observationId);
		this.requireSameAuthorizationTarget(current, refreshed, plan);
		if (runtimeState !== "idle")
			throw this.repairError(
				"The Executor runtime is not idle.",
				"Do not resume a working, pending, unreachable, or unknown runtime.",
			);
		this.requireAuthorizationCandidate(current, refreshed);
		return this.appendAuthorization(current, meta, refreshed, plan.binding, plan.selectedChecks, plan.authorizationId);
	}

	private async processAuthorization(authorization: CiRepairAuthorization): Promise<void> {
		if (this.reconcileStartedAuthorization(authorization)) return;
		const failure = await this.preflight(authorization);
		if (this.reconcileStartedAuthorization(authorization)) return;
		if (failure !== undefined) {
			appendCiRepairStatus(this.core, this.archive, failure.work, authorization, failure.status, failure.reason);
			return;
		}
		await this.launchAuthorizedRepair(authorization);
	}

	private reconcileStartedAuthorization(authorization: CiRepairAuthorization): boolean {
		if (!hasCiRepairStatus(this.archive, authorization, "started")) return false;
		if (hasTerminalCiRepairStatus(this.archive, authorization)) return true;
		if (this.executorRuntime.hasActiveTurn(authorization.workId, authorization.executionId)) return true;
		appendCiRepairStatus(
			this.core,
			this.archive,
			this.core.inspectWork(authorization.workId),
			authorization,
			"uncertain",
			"A prior repair attempt was marked started; do not retry it.",
		);
		return true;
	}

	private canAuthorizeFailure(work: WorkView, failure: CurrentCiFailure): boolean {
		return [
			this.repairWorkIsCurrent(work, failure.observation, "idle"),
			this.authorizationInvocationsAreSettled(work),
			!this.executorRuntime.hasActiveTurn(work.workId, work.execution?.executionId ?? ""),
			this.budgetAllows(work),
			!this.hasRepairAuthorizationForExecution(work),
			!this.hasStartedRepairForExecution(work),
		].every(Boolean);
	}

	private requireNoExistingExecutionAuthorization(work: WorkView): void {
		if (!this.hasRepairAuthorizationForExecution(work)) return;
		throw this.repairError(
			"This Execution already has a durable CI repair authorization.",
			"Do not authorize another repair continuation for this Execution.",
		);
	}

	private requireAuthorizationCandidate(work: WorkView, failure: CurrentCiFailure): void {
		if (this.canAuthorizeFailure(work, failure)) return;
		throw this.repairError(
			"The current CI failure cannot authorize another Executor turn.",
			"Confirm the same active Mission and Execution, settled invocations, idle runtime, and available token allowance before retrying.",
		);
	}

	private requireSameAuthorizationTarget(work: WorkView, refreshed: CurrentCiFailure, plan: AuthorizationPlan): void {
		if (sameAuthorizationTarget(work, refreshed, plan)) return;
		throw this.repairError(
			"The Work changed while the Executor runtime was inspected.",
			"Read the latest Archive and do not resume stale CI evidence.",
		);
	}

	private async preflight(authorization: CiRepairAuthorization): Promise<Preflight> {
		const work = this.core.inspectWork(authorization.workId);
		const failure = this.preProbeFailure(work, authorization);
		if (failure !== undefined) return failure;
		const runtimeState = await this.runtime.getState(authorization.binding).catch(() => "unknown" as const);
		const latest = this.core.inspectWork(authorization.workId);
		return this.postProbePreflight(latest, authorization, runtimeState);
	}

	private preProbeFailure(work: WorkView, authorization: CiRepairAuthorization): Preflight {
		if (!this.authorizationStillCurrent(work, authorization))
			return preflightFailure(
				work,
				"superseded",
				"The Work, Mission, Execution, review head, or CI observation changed before repair.",
			);
		return this.remainingPreProbeFailure(work, authorization);
	}

	private remainingPreProbeFailure(work: WorkView, authorization: CiRepairAuthorization): Preflight {
		if (!this.effectInvocationsAreSettled(work))
			return preflightFailure(work, "blocked", "An invocation is unsettled; no Executor turn was started.");
		if (this.executorRuntime.hasActiveTurn(work.workId, authorization.executionId))
			return preflightFailure(work, "blocked", "An Executor turn is active; no additional turn was started.");
		if (!this.budgetAllows(work))
			return preflightFailure(work, "blocked", "The Work or Execution allowance is exhausted; no turn was started.");
		return undefined;
	}

	private postProbePreflight(
		work: WorkView,
		authorization: CiRepairAuthorization,
		runtimeState: Awaited<ReturnType<AgentRuntimePort["getState"]>>,
	): Preflight {
		return [
			this.authorizationCurrentFailure(work, authorization),
			this.runtimeIdleFailure(work, runtimeState),
			this.settledInvocationFailure(work),
			this.inactiveExecutorFailure(work, authorization),
			this.tokenBudgetFailure(work),
			this.invocationCapacityFailure(work),
		].find(isPreflightFailure);
	}

	private authorizationCurrentFailure(work: WorkView, authorization: CiRepairAuthorization): Preflight {
		return this.authorizationStillCurrent(work, authorization)
			? undefined
			: preflightFailure(work, "superseded", "Current CI evidence or the bound Execution changed before launch.");
	}

	private runtimeIdleFailure(
		work: WorkView,
		runtimeState: Awaited<ReturnType<AgentRuntimePort["getState"]>>,
	): Preflight {
		return runtimeState === "idle"
			? undefined
			: preflightFailure(work, "blocked", "The Executor runtime is not provably idle.");
	}

	private settledInvocationFailure(work: WorkView): Preflight {
		return this.effectInvocationsAreSettled(work)
			? undefined
			: preflightFailure(work, "blocked", "An invocation became unsettled before launch.");
	}

	private inactiveExecutorFailure(work: WorkView, authorization: CiRepairAuthorization): Preflight {
		return this.executorRuntime.hasActiveTurn(work.workId, authorization.executionId)
			? preflightFailure(work, "blocked", "An Executor turn became active before launch.")
			: undefined;
	}

	private tokenBudgetFailure(work: WorkView): Preflight {
		return this.budgetAllows(work)
			? undefined
			: preflightFailure(work, "blocked", "The bounded token allowance changed before launch.");
	}

	private invocationCapacityFailure(work: WorkView): Preflight {
		try {
			this.invocations.requireCapacity(work);
			return undefined;
		} catch {
			return preflightFailure(
				work,
				"blocked",
				"The governed model invocation limit is occupied; no repair turn was started.",
			);
		}
	}

	private async launchAuthorizedRepair(authorization: CiRepairAuthorization): Promise<void> {
		const current = this.core.inspectWork(authorization.workId);
		if (this.blockIfRepairAlreadyStarted(current, authorization)) return;
		const execution = current.execution;
		if (!isAuthorizedExecution(execution, authorization)) {
			appendCiRepairStatus(
				this.core,
				this.archive,
				current,
				authorization,
				"blocked",
				"The current Execution changed before dispatch.",
			);
			return;
		}
		await this.runIfIdleOrRecord(authorization);
	}

	private async runIfIdleOrRecord(authorization: CiRepairAuthorization): Promise<void> {
		if (this.activeRepairs.has(authorization.authorizationId)) return;
		this.activeRepairs.add(authorization.authorizationId);
		try {
			await this.runOwnedRepair(authorization);
		} finally {
			this.activeRepairs.delete(authorization.authorizationId);
		}
	}

	private async runOwnedRepair(authorization: CiRepairAuthorization): Promise<void> {
		try {
			const ran = await this.executorRuntime.runIfIdle(authorization.workId, authorization.executionId, () =>
				this.startAndDispatchAuthorizedTurn(authorization),
			);
			if (!ran) this.recordIdleRace(authorization);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.recordFailedTurn(authorization, reason);
		}
	}

	private recordIdleRace(authorization: CiRepairAuthorization): void {
		if (hasCiRepairStatus(this.archive, authorization, "started")) return;
		appendCiRepairStatus(
			this.core,
			this.archive,
			this.core.inspectWork(authorization.workId),
			authorization,
			"blocked",
			"Another Executor turn became active before dispatch.",
		);
	}

	private async startAndDispatchAuthorizedTurn(authorization: CiRepairAuthorization): Promise<void> {
		const started = await this.prepareAuthorizedStart(authorization);
		if (started === undefined) return;
		await this.dispatchAndRecordOutcome(started.work, authorization, started.execution);
	}

	private async prepareAuthorizedStart(authorization: CiRepairAuthorization): Promise<StartedRepair | undefined> {
		const beforeProbe = this.core.inspectWork(authorization.workId);
		if (this.blockIfRepairAlreadyStarted(beforeProbe, authorization)) return undefined;
		const runtimeState = await this.runtime.getState(authorization.binding).catch(() => "unknown" as const);
		const current = this.core.inspectWork(authorization.workId);
		if (this.blockIfRepairAlreadyStarted(current, authorization)) return undefined;
		return this.commitAuthorizedStart(current, authorization, runtimeState);
	}

	private commitAuthorizedStart(
		current: WorkView,
		authorization: CiRepairAuthorization,
		runtimeState: Awaited<ReturnType<AgentRuntimePort["getState"]>>,
	): StartedRepair | undefined {
		const failure = this.finalStartPreflight(current, authorization, runtimeState);
		if (failure !== undefined) {
			appendCiRepairStatus(this.core, this.archive, failure.work, authorization, failure.status, failure.reason);
			return undefined;
		}
		return this.appendAuthorizedStart(current, authorization);
	}

	private appendAuthorizedStart(current: WorkView, authorization: CiRepairAuthorization): StartedRepair | undefined {
		const execution = current.execution;
		if (!isAuthorizedExecution(execution, authorization)) {
			appendCiRepairStatus(
				this.core,
				this.archive,
				current,
				authorization,
				"superseded",
				"The current Execution changed before dispatch.",
			);
			return undefined;
		}
		const startedStatus = appendStartedCiRepairStatus(this.core, this.archive, current, authorization);
		if (!startedStatus.appended) {
			this.blockIfRepairAlreadyStarted(this.core.inspectWork(authorization.workId), authorization);
			return undefined;
		}
		return { work: startedStatus.work, execution };
	}

	private finalStartPreflight(
		work: WorkView,
		authorization: CiRepairAuthorization,
		runtimeState: Awaited<ReturnType<AgentRuntimePort["getState"]>>,
	): Preflight {
		return [
			this.authorizationCurrentFailure(work, authorization),
			this.runtimeIdleFailure(work, runtimeState),
			this.settledInvocationFailure(work),
			this.tokenBudgetFailure(work),
			this.invocationCapacityFailure(work),
		].find(isPreflightFailure);
	}

	private async dispatchAndRecordOutcome(
		work: WorkView,
		authorization: CiRepairAuthorization,
		execution: NonNullable<WorkView["execution"]>,
	): Promise<void> {
		try {
			await this.dispatchAuthorizedTurn(work, authorization, execution);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.recordFailedTurn(authorization, reason);
			return;
		}
		this.recordTurnOutcome(authorization);
	}

	private recordTurnOutcome(authorization: CiRepairAuthorization): void {
		const current = this.core.inspectWork(authorization.workId);
		const reason = ciRepairCompletionFailure(this.archive, current, authorization);
		appendCiRepairStatus(
			this.core,
			this.archive,
			current,
			authorization,
			reason === undefined ? "completed" : "blocked",
			reason,
		);
	}

	private async dispatchAuthorizedTurn(
		work: WorkView,
		authorization: CiRepairAuthorization,
		execution: NonNullable<WorkView["execution"]>,
	): Promise<void> {
		const binding = await this.executorRuntime.dispatchTurn({
			work,
			execution,
			prompt: (live, runId) => ciRepairPrompt(authorization, live, runId),
			beforeSend: (live, runId) => this.requireCurrentTurn(live, authorization, runId),
		});
		if (binding === undefined)
			throw new InvocationLaunchError(new Error("The authorized CI repair became stale before dispatch."));
	}

	private recordFailedTurn(authorization: CiRepairAuthorization, reason: string): void {
		const work = this.core.inspectWork(authorization.workId);
		const uncertain = work.activeInvocations?.some(isUncertainExecutorInvocation) === true;
		appendCiRepairStatus(
			this.core,
			this.archive,
			work,
			authorization,
			uncertain ? "uncertain" : "blocked",
			reason.slice(0, 2_000),
		);
	}

	private requireCurrentTurn(work: WorkView, authorization: CiRepairAuthorization, runId: string): void {
		const failure = currentCiFailure(this.archive, work, authorization.observationId);
		if (failure !== undefined && this.currentExecutorRepairIsAuthorized(work, failure, authorization, runId)) return;
		throw new InvocationLaunchError(new Error("The CI repair authorization became stale before the Executor prompt."));
	}

	private currentExecutorRepairIsAuthorized(
		work: WorkView,
		failure: CurrentCiFailure,
		authorization: CiRepairAuthorization,
		runId: string,
	): boolean {
		return [
			this.repairWorkIsCurrent(work, failure.observation, "working"),
			this.budgetAllows(work),
			isCurrentAuthorizedTurn(work, failure, authorization, runId),
		].every(Boolean);
	}

	private repairWorkIsCurrent(
		work: WorkView,
		observation: ProviderCiObservation,
		runtimeState: "idle" | "working",
	): boolean {
		return [
			this.currentExecutionIsResumable(work, runtimeState),
			this.currentReviewMatches(work, observation),
			currentSignalAllowsRepair(work),
			currentValidationAllowsRepair(work),
		].every(Boolean);
	}

	private currentExecutionIsResumable(work: WorkView, runtimeState: "idle" | "working"): boolean {
		return (
			this.workMissionIsActive(work) &&
			this.executionIsRunning(work.execution, runtimeState) &&
			this.executionIsBoundToMission(work) &&
			this.executionCanContinue(work.execution)
		);
	}

	private workMissionIsActive(work: WorkView): boolean {
		return work.state === "active" && work.missionState === "active" && work.mission !== undefined;
	}

	private executionIsRunning(execution: WorkView["execution"], runtimeState: "idle" | "working"): boolean {
		return execution !== undefined && execution.state === "running" && execution.runtimeState === runtimeState;
	}

	private executionIsBoundToMission(work: WorkView): boolean {
		return work.execution !== undefined && work.execution.missionId === work.mission?.missionId;
	}

	private executionCanContinue(execution: WorkView["execution"]): boolean {
		return execution !== undefined && execution.blockReason === undefined && execution.pi !== undefined;
	}

	private currentReviewMatches(work: WorkView, observation: ProviderCiObservation): boolean {
		return currentReviewMatches(work, observation);
	}

	private requireCurrentFailure(work: WorkView, observationId: string): CurrentCiFailure {
		const failure = currentCiFailure(this.archive, work, observationId);
		if (failure !== undefined && failure.failedChecks.length > 0) return failure;
		throw this.repairError(
			"The selected CI observation is stale or does not contain matching failed checks.",
			"Read current provider evidence for the current repository, branches, pull request head, Mission, and Execution.",
		);
	}

	private hasAuthorizationFor(work: WorkView, authorizationId: string): boolean {
		return archiveHasAuthorization(
			this.archive,
			{
				workId: work.workId,
				missionId: work.mission?.missionId,
				executionId: work.execution?.executionId,
				kinds: ["delivery"],
				order: "desc",
			},
			authorizationId,
		);
	}

	private hasRepairAuthorizationForExecution(work: WorkView): boolean {
		const scope = currentFailureScope(work);
		if (scope === undefined) return false;
		return archiveHasExecutionAuthorization(this.archive, {
			workId: work.workId,
			...scope,
			kinds: ["delivery"],
			order: "desc",
		});
	}

	private hasStartedRepairForExecution(work: WorkView): boolean {
		const execution = work.execution;
		return (
			execution !== undefined &&
			this.archive.findCommand(executionStartCommandId(work.workId, execution.executionId)) !== undefined
		);
	}

	private blockIfRepairAlreadyStarted(work: WorkView, authorization: CiRepairAuthorization): boolean {
		if (!this.hasStartedRepairForExecution(work)) return false;
		if (this.reconcileStartedAuthorization(authorization)) return true;
		appendCiRepairStatus(
			this.core,
			this.archive,
			work,
			authorization,
			"blocked",
			"Another CI repair already started for this Execution.",
		);
		return true;
	}

	private authorizationInvocationsAreSettled(work: WorkView): boolean {
		const active = work.activeInvocations;
		if (active === undefined) return false;
		return active.length === 0 || isCurrentConclaveReservation(active);
	}

	private effectInvocationsAreSettled(work: WorkView): boolean {
		return work.activeInvocations !== undefined && work.activeInvocations.length === 0;
	}

	private budgetAllows(work: WorkView): boolean {
		const execution = work.execution;
		if (execution === undefined) return false;
		return (
			dispatchEligibility(work) === "eligible" && invocationAllowance(work) > 0 && hasExecutionAllowance(execution)
		);
	}

	private appendAuthorization(
		work: WorkView,
		meta: CommandMeta,
		failure: CurrentCiFailure,
		binding: RuntimeBinding,
		selectedChecks: readonly ProviderCheck[],
		authorizationId: string,
	): WorkView {
		const mission = work.mission;
		const execution = work.execution;
		const request = work.reviewRequest;
		if (mission === undefined || execution === undefined || request === undefined)
			throw this.repairError(
				"The current Mission, Execution, or review request is missing.",
				"Read the Archive and reconcile current Work state.",
			);
		const authorization: CiRepairAuthorization = {
			authorizationId,
			workId: work.workId,
			missionId: mission.missionId,
			executionId: execution.executionId,
			observationId: failure.observation.observationId,
			observationSequence: failure.record.sequence,
			headCommit: request.headCommit,
			binding,
			selectedChecks,
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			nextAction: "Conclave authorized one bounded provider CI repair.",
		};
		return this.core.append({
			meta,
			kind: "delivery",
			workId: work.workId,
			missionId: mission.missionId,
			executionId: execution.executionId,
			payload: { kind: "ci-repair", status: "authorized", ...authorization },
			projection: next,
			evidenceRefs: [authorization.observationId, ...selectedChecks.map((check) => check.name)],
			summary: "Conclave authorized one bounded provider CI repair.",
			effects: [
				{
					effectId: `ci-repair-wake:${work.workId}:${execution.executionId}:${failure.record.sequence}`,
					kind: "ci-repair-wake",
					payload: { workId: work.workId, authorizationCommandId: meta.commandId },
				},
			],
		}).projection;
	}

	private readEffectAuthorization(effect: PendingArchiveEffect): CiRepairAuthorization | undefined {
		const workId = readEffectWorkId(effect.payload);
		const commandId = readEffectText(effect.payload, "authorizationCommandId");
		const found = this.archive.findCommand(commandId);
		const authorization = found === undefined ? undefined : parseAuthorization(found.record);
		return authorization?.workId === workId ? authorization : undefined;
	}

	private authorizationStillCurrent(work: WorkView, authorization: CiRepairAuthorization): boolean {
		const failure = currentCiFailure(this.archive, work, authorization.observationId);
		return (
			failure !== undefined &&
			authorizationStillTargetsWork(work, authorization, failure) &&
			this.repairWorkIsCurrent(work, failure.observation, "idle")
		);
	}

	private repairError(summary: string, remediation: string) {
		return this.core.error("invalid-state", summary, false, remediation);
	}
}
