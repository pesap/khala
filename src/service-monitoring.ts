import { type ArchivePort, RevisionConflict } from "./archive.js";
import {
	type CommandMeta,
	type ErrorEnvelope,
	type ProviderObservation,
	type ProviderOutcomeObservation,
	type WorkView,
} from "./model.js";
import { type OperationContext, type RuntimeState, type ServicePorts } from "./ports.js";
import {
	changedProviderObservation,
	classifyProviderObservation,
	isProviderMonitorError,
	normalizeProviderObservation,
	observationKey,
	providerObservationEffects,
	providerObservationEvidence,
	providerObservationProjection,
	providerRecoveryProjection,
	providerRecoverySummary,
	recoveredProviderObservation,
	schedulerEffect,
	validProviderOutcomeObservation,
} from "./provider-observation-policy.js";
import type { ArchiveCore } from "./service-archive-core.js";
import {
	isProviderOutcomeSettlementPending,
	shouldMonitorProvider,
	updatedRuntimeView,
} from "./service-dispatch-policy.js";
import { normalizeCaughtError, sameObservationIdentity } from "./service-foundation-policy.js";
import { isRevisionConflictError, sameObservation } from "./service-lifecycle-policy.js";
import {
	latestObservationFingerprint,
	monitorFailureEnvelope,
	monitorFailureMarker,
	observationFingerprint,
	providerOutcomeWakeMarker,
	throwIfOperationAborted,
} from "./service-runtime-policy.js";
import {
	hasRuntimeChange,
	isRuntimeUnavailable,
	monitorMeta,
	runtimeBinding,
	runtimeNeedsInspection,
} from "./service-state-policy.js";

export type MonitoringCallbacks = Readonly<{
	acquireSupervision: () => boolean;
	processPendingEffects: () => Promise<void>;
	recordRuntimeState: (work: WorkView, state: RuntimeState, unavailable: boolean) => void;
}>;

export class ServiceMonitoring {
	private readonly heartbeat = new Map<string, string>();
	private autonomousRun: Promise<void> | undefined;
	private readonly core: ArchiveCore;
	private readonly archive: ArchivePort;
	private readonly ports: ServicePorts;
	private readonly callbacks: MonitoringCallbacks;

	constructor(core: ArchiveCore, archive: ArchivePort, ports: ServicePorts, callbacks: MonitoringCallbacks) {
		this.core = core;
		this.archive = archive;
		this.ports = ports;
		this.callbacks = callbacks;
	}

	get activeRun(): Promise<void> | undefined {
		return this.autonomousRun;
	}

	async inspectRuntime(workId: string, meta?: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		const work = this.core.inspectWork(workId);
		this.authorizeRuntimeInspection(work, meta);
		if (!runtimeNeedsInspection(work)) return work;
		operation?.onUpdate?.("Inspecting the bound Pi runtime.");
		const runtimeState = await this.ports.runtime.getState(runtimeBinding(work), operation);
		throwIfOperationAborted(operation);
		return updatedRuntimeView(work, runtimeState);
	}

	async pollProvider(workId: string, meta: CommandMeta, operation?: OperationContext): Promise<WorkView> {
		this.core.requireAnyActor(meta, ["user", "monitor"]);
		const work = this.core.inspectWork(workId);
		this.core.checkRevision(work, meta);
		const reviewRequest = this.pollableReviewRequest(work);
		operation?.onUpdate?.("Polling the configured review provider.");
		const observations = await this.providerObservations(reviewRequest, operation);
		throwIfOperationAborted(operation);
		return this.recordProviderObservations(work, observations, meta);
	}

	async runAutonomousCycle(): Promise<void> {
		if (!this.callbacks.acquireSupervision()) return;
		if (this.autonomousRun !== undefined) return this.autonomousRun;
		const run = this.runAutonomousCycleOnce();
		this.autonomousRun = run;
		try {
			await run;
		} finally {
			if (this.autonomousRun === run) this.autonomousRun = undefined;
		}
	}

	recordMonitorFailure(work: WorkView, subject: string, failure: Error): void {
		const message = failure.message.trim().slice(0, 2_000) || "The monitor returned no error detail.";
		const marker = monitorFailureMarker(subject, work.workId);
		if (this.heartbeat.get(marker) === message) return;
		this.appendMonitorFailure(work, subject, message, marker, 0);
	}

	recordServiceMonitorFailure(failure: Error): void {
		const work = this.archive.listProjects()[0];
		if (work === undefined) return;
		try {
			this.recordMonitorFailure(work, "Autonomous monitor", failure);
		} catch {
			// No durable Work target remains for this monitor failure.
		}
	}

	private authorizeRuntimeInspection(work: WorkView, meta: CommandMeta | undefined): void {
		if (meta === undefined) return;
		this.core.requireReadableActor(meta.actor);
		this.core.checkRevision(work, meta);
		if (meta.actor !== "user") this.core.requireRoleBinding(meta, work);
	}

	private async runAutonomousCycleOnce(): Promise<void> {
		const bucket = Math.floor(Date.now() / 60_000);
		for (const item of this.archive.listProjects()) await this.monitorWork(item.workId, bucket);
		await this.callbacks.processPendingEffects();
	}

	private async monitorWork(workId: string, bucket: number): Promise<void> {
		await this.monitorProvider(workId, bucket);
		await this.monitorProviderOutcome(workId);
		await this.monitorExecutor(workId);
	}

	private async monitorProvider(workId: string, bucket: number): Promise<void> {
		const work = this.core.inspectWork(workId);
		if (!shouldMonitorProvider(work)) return;
		await this.attemptProviderMonitor(work, bucket);
	}

	private async attemptProviderMonitor(work: WorkView, bucket: number): Promise<void> {
		try {
			await this.pollProvider(work.workId, monitorMeta(work, "provider", bucket));
		} catch (error) {
			// SAFETY: monitor error normalization accepts Error objects and stringifies other thrown values.
			this.handleMonitorError(work, "Provider", error as Error | string);
		}
	}

	private async monitorProviderOutcome(workId: string): Promise<void> {
		const work = this.core.inspectWork(workId);
		if (!isProviderOutcomeSettlementPending(work)) return;
		await this.attemptProviderOutcomeMonitor(work);
	}

	private async attemptProviderOutcomeMonitor(work: WorkView): Promise<void> {
		try {
			this.queueProviderOutcomeWake(work);
		} catch (error) {
			// SAFETY: monitor error normalization accepts Error objects and stringifies other thrown values.
			this.handleMonitorError(work, "Provider outcome reconciliation", error as Error | string);
		}
	}

	private async monitorExecutor(workId: string): Promise<void> {
		const work = this.core.inspectWork(workId);
		if (!runtimeNeedsInspection(work)) return;
		await this.attemptExecutorMonitor(work);
	}

	private async attemptExecutorMonitor(work: WorkView): Promise<void> {
		try {
			this.recordObservedRuntime(work, await this.inspectRuntime(work.workId));
		} catch (error) {
			// SAFETY: monitor error normalization accepts Error objects and stringifies other thrown values.
			this.handleMonitorError(work, "Executor runtime", error as Error | string);
		}
	}

	private handleMonitorError(work: WorkView, subject: string, error: Error | string): void {
		if (error instanceof RevisionConflict) return;
		this.recordMonitorError(work, subject, error);
	}

	private recordMonitorError(work: WorkView, subject: string, error: Error | string): void {
		this.recordMonitorFailure(work, subject, normalizeCaughtError(error));
	}

	private recordObservedRuntime(work: WorkView, observed: WorkView): void {
		const runtimeState = observed.execution?.runtimeState;
		if (hasRuntimeChange(work, runtimeState))
			this.callbacks.recordRuntimeState(work, runtimeState, isRuntimeUnavailable(runtimeState));
	}

	private pollableReviewRequest(work: WorkView): NonNullable<WorkView["reviewRequest"]> {
		if (["succeeded", "stopped"].includes(work.state))
			throw this.core.error(
				"invalid-state",
				"Terminal Work cannot be polled.",
				false,
				"Inspect the terminal Work evidence instead of polling its review request.",
			);
		if (work.reviewRequest === undefined)
			throw this.core.error(
				"invalid-state",
				"Provider polling requires a review request.",
				false,
				"Publish a draft review request first.",
			);
		return work.reviewRequest;
	}

	private async providerObservations(
		reviewRequest: NonNullable<WorkView["reviewRequest"]>,
		operation: OperationContext | undefined,
	): Promise<ProviderObservation[]> {
		const observations = [...(await this.ports.codeHost.poll(reviewRequest, operation))];
		const capabilities = await this.ports.codeHost.capabilities(operation);
		if (capabilities.supportsMergeObservation) {
			const outcome = await this.ports.codeHost.inspectOutcome(reviewRequest, operation);
			if (outcome !== undefined) observations.push(outcome);
		}
		return observations;
	}

	private recordProviderObservations(
		initial: WorkView,
		observations: readonly ProviderObservation[],
		meta: CommandMeta,
	): WorkView {
		let work = initial;
		for (const [index, observation] of observations.entries())
			work = this.recordObservation(work.workId, observation, `${meta.commandId}:${index}`, work.revision);
		return work.lastError !== undefined && isProviderMonitorError(work.lastError)
			? this.recordProviderPollRecovery(work, observations[0], `${meta.commandId}:recovered`)
			: work;
	}

	private recordObservation(
		workId: string,
		observation: ProviderObservation,
		commandId: string,
		expectedWorkRevision: number,
	): WorkView {
		const prior = this.archive.findCommand(commandId);
		if (prior !== undefined) return this.replayObservation(prior, workId, commandId);
		const work = this.core.inspectWork(workId);
		const meta: CommandMeta = { actor: "monitor", commandId, expectedWorkRevision, schemaVersion: 1 };
		this.core.checkRevision(work, meta);
		const reviewRequest = this.requireObservationReview(work, observation);
		this.validateProviderOutcomeObservation(reviewRequest, observation);
		const normalized = normalizeProviderObservation(observation, reviewRequest);
		const classification = classifyProviderObservation(normalized, reviewRequest);
		const key = observationKey(workId, normalized);
		const fingerprint = observationFingerprint(normalized);
		const previous = this.heartbeat.get(key) ?? this.persistedObservationFingerprint(work, normalized);
		if (previous === fingerprint)
			return this.recordUnchangedObservation(work, normalized, observation, commandId, key, fingerprint);
		return this.recordChangedObservation(work, observation, normalized, classification, meta);
	}

	private recordChangedObservation(
		work: WorkView,
		observation: ProviderObservation,
		normalized: ProviderObservation,
		classification: ReturnType<typeof classifyProviderObservation>,
		meta: CommandMeta,
	): WorkView {
		const nextObservation = changedProviderObservation(observation, normalized);
		const next = providerObservationProjection(work, nextObservation, classification);
		const result = this.core.append({
			meta,
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: nextObservation,
			projection: next,
			summary: `Provider observation changed: ${observation.kind}.`,
			evidenceRefs: providerObservationEvidence(work, observation),
			effects: providerObservationEffects(work.workId, next.revision, observation, classification),
		});
		this.clearProviderMonitorFailure(work);
		this.heartbeat.set(observationKey(work.workId, normalized), observationFingerprint(normalized));
		this.recordProviderOutcomeMarker(result.projection, observation);
		return result.projection;
	}

	private replayObservation(
		prior: NonNullable<ReturnType<ArchivePort["findCommand"]>>,
		workId: string,
		commandId: string,
	): WorkView {
		if (prior.record.workId === workId) return prior.projection;
		throw this.core.error(
			"invalid-input",
			`Command ${commandId} was already used for Work ${prior.record.workId}.`,
			false,
			"Use a new command ID for this Work.",
		);
	}

	private requireObservationReview(
		work: WorkView,
		observation: ProviderObservation,
	): NonNullable<WorkView["reviewRequest"]> {
		const reviewRequest = work.reviewRequest;
		if (reviewRequest !== undefined && observation.providerId === reviewRequest.providerId) return reviewRequest;
		throw this.core.error(
			"invalid-input",
			"Provider observation does not match the current review request.",
			false,
			"Poll the current provider review request.",
		);
	}

	private validateProviderOutcomeObservation(
		reviewRequest: NonNullable<WorkView["reviewRequest"]>,
		observation: ProviderObservation,
	): void {
		if (observation.kind !== "provider-outcome") return;
		if (validProviderOutcomeObservation(reviewRequest, observation)) return;
		throw this.core.error(
			"invalid-input",
			"Provider outcome evidence must report the merged reviewed head and merge commit.",
			false,
			"Use the provider adapter's confirmed merge observation.",
		);
	}

	private persistedObservationFingerprint(work: WorkView, observation: ProviderObservation): string | undefined {
		const last = work.lastObservation;
		if (sameObservationIdentity(last, observation))
			return sameObservation(last, observation) ? observationFingerprint(last) : undefined;
		return latestObservationFingerprint(this.archive, work.workId, observation);
	}

	private recordUnchangedObservation(
		work: WorkView,
		normalized: ProviderObservation,
		observation: ProviderObservation,
		commandId: string,
		key: string,
		fingerprint: string,
	): WorkView {
		this.heartbeat.set(key, fingerprint);
		if (observation.kind === "provider-outcome") return this.queueProviderOutcomeWake(work);
		return work.lastError === undefined || !isProviderMonitorError(work.lastError)
			? work
			: this.recordProviderPollRecovery(work, normalized, `${commandId}:recovered`);
	}

	private clearProviderMonitorFailure(work: WorkView): void {
		if (work.lastError !== undefined && isProviderMonitorError(work.lastError))
			this.heartbeat.delete(monitorFailureMarker("Provider", work.workId));
	}

	private recordProviderOutcomeMarker(work: WorkView, observation: ProviderObservation): void {
		if (observation.kind === "provider-outcome" && isProviderOutcomeSettlementPending(work))
			this.heartbeat.set(providerOutcomeWakeMarker(work.workId, observation.observationId), "queued");
	}

	private recordProviderPollRecovery(
		work: WorkView,
		observation: ProviderObservation | undefined,
		commandId: string,
	): WorkView {
		const reviewRequest = work.reviewRequest;
		if (reviewRequest === undefined) return work;
		const recoveredObservation = recoveredProviderObservation(observation, reviewRequest, commandId);
		const next = providerRecoveryProjection(work, reviewRequest, recoveredObservation);
		const result = this.core.append({
			meta: { actor: "monitor", commandId, expectedWorkRevision: work.revision, schemaVersion: 1 },
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: recoveredObservation,
			projection: next,
			summary: providerRecoverySummary(observation, recoveredObservation),
			evidenceRefs: providerObservationEvidence(work, recoveredObservation),
		});
		this.heartbeat.delete(monitorFailureMarker("Provider", work.workId));
		return result.projection;
	}

	private queueProviderOutcomeWake(work: WorkView): WorkView {
		if (!isProviderOutcomeSettlementPending(work)) return work;
		const outcome = work.providerOutcome;
		const marker = providerOutcomeWakeMarker(work.workId, outcome.observationId);
		if (this.heartbeat.has(marker)) return work;
		return this.appendProviderOutcomeWake(work, outcome, marker);
	}

	private appendProviderOutcomeWake(work: WorkView, outcome: ProviderOutcomeObservation, marker: string): WorkView {
		const observation: ProviderOutcomeObservation = {
			...outcome,
			changed: false,
			observedAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastObservation: observation,
			nextAction: "Provider merge observed; Conclave is recording the Outcome.",
		};
		const result = this.core.append({
			meta: {
				actor: "monitor",
				commandId: `${marker}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: observation,
			projection: next,
			evidenceRefs: providerObservationEvidence(work, observation),
			summary: "Provider merge remains unsettled; Conclave settlement wake queued.",
			effects: [schedulerEffect(work.workId, next.revision, undefined, "provider-outcome")],
		});
		this.heartbeat.set(marker, "queued");
		return result.projection;
	}

	private appendMonitorFailure(
		work: WorkView,
		subject: string,
		message: string,
		marker: string,
		attempt: number,
	): void {
		const error = monitorFailureEnvelope(work, subject, message);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: error,
			nextAction: `${subject} monitor failed; retrying automatically.`,
		};
		try {
			this.appendMonitorFailureRecord(work, error, next, marker);
			this.heartbeat.set(marker, message);
		} catch (appendError) {
			this.handleMonitorFailureAppendError(
				appendError instanceof Error ? appendError : new Error(String(appendError)),
				work,
				subject,
				message,
				marker,
				attempt,
			);
		}
	}

	private appendMonitorFailureRecord(work: WorkView, error: ErrorEnvelope, next: WorkView, marker: string): void {
		this.core.append({
			meta: {
				actor: "monitor",
				commandId: `${marker}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: error,
			evidenceRefs: error.evidenceRefs,
			projection: next,
			summary: error.summary,
		});
	}

	private handleMonitorFailureAppendError(
		error: Error,
		work: WorkView,
		subject: string,
		message: string,
		marker: string,
		attempt: number,
	): void {
		if (!isRevisionConflictError(error)) throw error;
		const latest = this.archive.project(work.workId);
		if (latest !== undefined && attempt === 0) this.appendMonitorFailure(latest, subject, message, marker, 1);
	}
}
