import type { Action, Actor, ProviderObservation, WorkView } from "./model.js";
import type { RuntimeState } from "./ports.js";
import { ArchiveCore } from "./service-archive-core.js";
import {
	isProviderOutcomeSettlementPending,
	oracleReady,
	oracleReason,
	startExecutionEnabled,
	startExecutionReasonForWork,
} from "./service-dispatch-policy.js";
import {
	type ActionSpec,
	canRequestInput,
	feedbackReason,
	recoveryReason,
	requestInputReason,
} from "./service-foundation-policy.js";
import { isResumableIdleExecutor } from "./service-idle-recovery.js";
import { amendMissionReason, observerReason, oracleInputsReady } from "./service-lifecycle-policy.js";
import {
	canAmendMission,
	canLaunchObserver,
	unavailableRuntime,
	userActionSpecs,
	verdictReady,
	verdictReason,
} from "./service-runtime-policy.js";

type FeedbackAvailability = (work: WorkView, observation: ProviderObservation) => boolean;
type CiRepairAvailability = (work: WorkView) => boolean;

export class ServiceActions {
	private readonly core: ArchiveCore;
	private readonly feedbackAvailable: FeedbackAvailability;
	private readonly ciRepairAvailable: CiRepairAvailability;

	constructor(core: ArchiveCore, feedbackAvailable: FeedbackAvailability, ciRepairAvailable: CiRepairAvailability) {
		this.core = core;
		this.feedbackAvailable = feedbackAvailable;
		this.ciRepairAvailable = ciRepairAvailable;
	}

	available(workId: string, actor: Actor, revision?: number, runtimeState?: RuntimeState): readonly Action[] {
		const work = this.core.inspectWork(workId);
		const expected = revision ?? work.revision;
		const runtimeUnavailable = unavailableRuntime(work, runtimeState);
		const builders = new Map<Actor, () => readonly Action[]>([
			["user", () => this.userActions(work, expected, this.recoveryAvailable(work, runtimeState, runtimeUnavailable))],
			["conclave", () => this.conclaveActions(work, expected, runtimeUnavailable)],
			["executor", () => this.executorActions(work, expected)],
		]);
		return builders.get(actor)?.() ?? [];
	}

	private actionList(work: WorkView, expected: number, specs: readonly ActionSpec[]): readonly Action[] {
		return specs.map((spec) => this.core.action(spec.kind, work, expected, spec));
	}

	private recoveryAvailable(
		work: WorkView,
		runtimeState: RuntimeState | undefined,
		runtimeUnavailable: boolean,
	): boolean {
		if (runtimeUnavailable) return true;
		return isResumableIdleExecutor(work, runtimeState);
	}

	private userActions(work: WorkView, expected: number, recoverable: boolean): readonly Action[] {
		const specs = userActionSpecs(work, recoverable);
		if ((work.activeInvocations?.length ?? 0) === 0) return this.actionList(work, expected, specs);
		return this.actionList(work, expected, [...specs, { kind: "reconcile-invocation", enabled: true }]);
	}

	private conclaveActions(work: WorkView, expected: number, runtimeUnavailable: boolean): readonly Action[] {
		return this.actionList(work, expected, this.conclaveActionSpecs(work, runtimeUnavailable));
	}

	private conclaveActionSpecs(work: WorkView, runtimeUnavailable: boolean): readonly ActionSpec[] {
		return [
			{
				kind: "request-input",
				enabled: canRequestInput(work),
				disabledReason: requestInputReason(work),
			},
			{
				kind: "amend-mission",
				enabled: canAmendMission(work),
				disabledReason: amendMissionReason(work),
			},
			{
				kind: "recover",
				enabled: runtimeUnavailable,
				disabledReason: recoveryReason(runtimeUnavailable),
			},
			{ kind: "admit", enabled: work.state === "submitted" },
			{
				kind: "fail-work",
				enabled: work.state !== "succeeded" && work.state !== "stopped",
				disabledReason: "Terminal Work cannot be failed again.",
			},
			{
				kind: "launch-observer",
				enabled: canLaunchObserver(work),
				disabledReason: observerReason(work),
			},
			{
				kind: "start-execution",
				enabled: startExecutionEnabled(work),
				disabledReason: startExecutionReasonForWork(work),
			},
			{ kind: "verdict", enabled: verdictReady(work), disabledReason: verdictReason(work) },
			{
				kind: "run-oracle",
				enabled: oracleReady(work),
				disabledReason: oracleReason(oracleReady(work), oracleInputsReady(work)),
			},
			{
				kind: "record-outcome",
				enabled: isProviderOutcomeSettlementPending(work),
				disabledReason: "Provider-confirmed merge evidence is required for active or awaiting-review Work.",
			},
			this.feedbackActionSpec(work),
			{
				kind: "repair-ci",
				enabled: this.ciRepairAvailable(work),
				disabledReason:
					"A current matching CI failure, unblocked validation, and an idle, budgeted Executor are required.",
			},
		];
	}

	private feedbackActionSpec(work: WorkView): ActionSpec {
		const observation = work.lastObservation;
		const enabled = observation !== undefined && this.feedbackAvailable(work, observation);
		return {
			kind: "deliver-feedback",
			enabled,
			disabledReason: feedbackReason(enabled),
		};
	}

	private executorActions(work: WorkView, expected: number): readonly Action[] {
		const running = work.execution?.state === "running";
		return this.actionList(work, expected, [
			{
				kind: "commit-sandbox",
				enabled: running,
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "run-validation",
				enabled: running,
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "record-signal",
				enabled: running,
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "create-review-request",
				enabled: running,
				disabledReason: "A running Execution is required.",
			},
		]);
	}
}
