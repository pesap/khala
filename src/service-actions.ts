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

export class ServiceActions {
	private readonly core: ArchiveCore;
	private readonly feedbackAvailable: FeedbackAvailability;

	constructor(core: ArchiveCore, feedbackAvailable: FeedbackAvailability) {
		this.core = core;
		this.feedbackAvailable = feedbackAvailable;
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
		return specs.map((spec) =>
			this.core.action(spec.kind, work, expected, spec.enabled, spec.label, spec.disabledReason),
		);
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
		return this.actionList(work, expected, [
			...specs,
			{ kind: "reconcile-invocation", enabled: true, label: "Reconcile held invocation" },
		]);
	}

	private conclaveActions(work: WorkView, expected: number, runtimeUnavailable: boolean): readonly Action[] {
		return this.actionList(work, expected, this.conclaveActionSpecs(work, runtimeUnavailable));
	}

	private conclaveActionSpecs(work: WorkView, runtimeUnavailable: boolean): readonly ActionSpec[] {
		return [
			{
				kind: "request-input",
				enabled: canRequestInput(work),
				label: "Request User input",
				disabledReason: requestInputReason(work),
			},
			{
				kind: "amend-mission",
				enabled: canAmendMission(work),
				label: "Amend Mission",
				disabledReason: amendMissionReason(work),
			},
			{
				kind: "recover",
				enabled: runtimeUnavailable,
				label: "Recover Executor runtime",
				disabledReason: recoveryReason(runtimeUnavailable),
			},
			{ kind: "admit", enabled: work.state === "submitted", label: "Admit Work" },
			{
				kind: "fail-work",
				enabled: work.state !== "succeeded" && work.state !== "stopped",
				label: "Fail Work",
				disabledReason: "Terminal Work cannot be failed again.",
			},
			{
				kind: "launch-observer",
				enabled: canLaunchObserver(work),
				label: "Gather missing repository context",
				disabledReason: observerReason(work),
			},
			{
				kind: "start-execution",
				enabled: startExecutionEnabled(work),
				label: "Start Execution",
				disabledReason: startExecutionReasonForWork(work),
			},
			{ kind: "verdict", enabled: verdictReady(work), label: "Issue Verdict", disabledReason: verdictReason(work) },
			{
				kind: "run-oracle",
				enabled: oracleReady(work),
				label: "Run Oracle review",
				disabledReason: oracleReason(oracleReady(work), oracleInputsReady(work)),
			},
			{
				kind: "record-outcome",
				enabled: isProviderOutcomeSettlementPending(work),
				label: "Record Work Outcome",
				disabledReason: "Provider-confirmed merge evidence is required for active or awaiting-review Work.",
			},
			this.feedbackActionSpec(work),
		];
	}

	private feedbackActionSpec(work: WorkView): ActionSpec {
		const observation = work.lastObservation;
		const enabled = observation !== undefined && this.feedbackAvailable(work, observation);
		return {
			kind: "deliver-feedback",
			enabled,
			label: "Deliver provider feedback",
			disabledReason: feedbackReason(enabled),
		};
	}

	private executorActions(work: WorkView, expected: number): readonly Action[] {
		const running = work.execution?.state === "running";
		return this.actionList(work, expected, [
			{
				kind: "commit-sandbox",
				enabled: running,
				label: "Commit sandbox changes",
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "run-validation",
				enabled: running,
				label: "Run validation",
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "record-signal",
				enabled: running,
				label: "Record Signal",
				disabledReason: "The current Execution is not running.",
			},
			{
				kind: "create-review-request",
				enabled: running,
				label: "Create or reconcile draft review request",
				disabledReason: "A running Execution is required.",
			},
		]);
	}
}
