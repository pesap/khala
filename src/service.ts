import { createHash, createPublicKey, type KeyObject, randomUUID, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { type ArchiveAppend, type ArchivePort, ExecutionAdmissionConflict, RevisionConflict } from "./archive.js";
import {
	type Action,
	type ActionCommand,
	type ActionInput,
	type Actor,
	assertNonBlank,
	assertPositiveInteger,
	type CommandMeta,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type JsonObject,
	type JsonValue,
	type Mission,
	type MissionSpecificity,
	type MissionState,
	type Page,
	type ProviderObservation,
	type RecordQuery,
	type RecordView,
	type RecoveryUpdate,
	type RoleSetting,
	type RoleSettingsMap,
	type ServiceResult,
	type Signal,
	type SubmitWorkInput,
	type TokenUsage,
	type WorkBudget,
	type WorkState,
	type WorkSummary,
	type WorkTerms,
	type WorkView,
} from "./model.js";
import type { OracleResult, RuntimeBinding, RuntimeState, RuntimeTurn, ServicePorts } from "./ports.js";

export type ServiceOptions = Readonly<{
	projectPath: string;
	targetBranch: string;
	maxConcurrentExecutions: number;
	defaultWorkTokens: number;
	conclaveModel: string;
	conclaveThinking: string;
	executorModel: string;
	executorThinking: string;
	oracleModel: string;
	oracleThinking: string;
	observerModel: string;
	observerThinking: string;
	conclavePromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	executorPromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	observerPromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	oraclePromptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>;
	rolePublicKey: string;
	autonomousMonitor?: boolean | undefined;
}>;

type RoleCapability = Readonly<{
	role: Actor;
	workId?: string | undefined;
	executionId?: string | undefined;
	nonce?: string | undefined;
}>;
const providerPollAuthority = Symbol("provider-poll-authority");
const AUTONOMOUS_MONITOR_INTERVAL_MS = 60_000;
const SUPPORTED_EFFECT_KINDS: ReadonlySet<string> = new Set([
	"conclave-wake",
	"scheduler-wake",
	"executor-wake",
	"executor-stop",
	"executor-recovery",
	"observer-wake",
	"feedback-wake",
	"workspace-cleanup",
	"observer-cleanup",
]);
const DEFAULT_SCOPE = "Repository changes required by the objective.";
const DEFAULT_VALIDATION = "Run the project's configured validation commands.";

export class ActionInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionInputError";
	}
}

export class ApplicationError extends Error {
	readonly envelope: ErrorEnvelope;

	constructor(envelope: ErrorEnvelope) {
		super(envelope.summary);
		this.name = "ApplicationError";
		this.envelope = envelope;
	}
}

export class ApplicationService {
	private readonly heartbeat = new Map<string, string>();
	private readonly drivingExecutions = new Map<string, Promise<void>>();
	private readonly activeExecutorTurns = new Map<string, Set<Promise<void>>>();
	private readonly drivingObservers = new Set<string>();
	private readonly backgroundOperations = new Set<Promise<void>>();
	private pendingEffectsRun: Promise<void> | undefined;
	// A caller can request another pass while the serialized worker is still unwinding.
	private pendingEffectsRequested = false;
	private autonomousCycleRun: Promise<void> | undefined;
	private readonly monitorTimer: ReturnType<typeof setInterval> | undefined;
	private closing = false;
	private readonly archive: ArchivePort;
	private readonly ports: ServicePorts;
	private options: ServiceOptions;
	private readonly rolePublicKey: KeyObject;

	constructor(archive: ArchivePort, ports: ServicePorts, options: ServiceOptions) {
		this.archive = archive;
		this.ports = ports;
		this.options = options;
		this.rolePublicKey = createPublicKey({
			key: Buffer.from(options.rolePublicKey, "base64url"),
			format: "der",
			type: "spki",
		});
		if (options.autonomousMonitor !== false) {
			const timer = setInterval(
				() =>
					void this.runAutonomousCycle().catch((error) =>
						this.recordServiceMonitorFailure(error instanceof Error ? error : new Error(String(error))),
					),
				AUTONOMOUS_MONITOR_INTERVAL_MS,
			);
			timer.unref();
			this.monitorTimer = timer;
		}
	}

	getRoleSettings(): RoleSettingsMap {
		return {
			conclave: { model: this.options.conclaveModel, thinking: this.options.conclaveThinking },
			executor: { model: this.options.executorModel, thinking: this.options.executorThinking },
			observer: { model: this.options.observerModel, thinking: this.options.observerThinking },
			oracle: { model: this.options.oracleModel, thinking: this.options.oracleThinking },
		};
	}

	// oxlint-disable-next-line complexity
	updateRoleSetting(role: GovernedRole, setting: RoleSetting, value: string): void {
		const normalized = assertNonBlank(value, `${role} ${setting}`);
		if (role === "conclave") {
			this.options = {
				...this.options,
				conclaveModel: setting === "model" ? normalized : this.options.conclaveModel,
				conclaveThinking: setting === "thinking" ? normalized : this.options.conclaveThinking,
			};
			return;
		}
		if (role === "executor") {
			this.options = {
				...this.options,
				executorModel: setting === "model" ? normalized : this.options.executorModel,
				executorThinking: setting === "thinking" ? normalized : this.options.executorThinking,
			};
			return;
		}
		if (role === "observer") {
			this.options = {
				...this.options,
				observerModel: setting === "model" ? normalized : this.options.observerModel,
				observerThinking: setting === "thinking" ? normalized : this.options.observerThinking,
			};
			return;
		}
		this.options = {
			...this.options,
			oracleModel: setting === "model" ? normalized : this.options.oracleModel,
			oracleThinking: setting === "thinking" ? normalized : this.options.oracleThinking,
		};
	}

	// oxlint-disable-next-line complexity
	submitWork(input: SubmitWorkInput, meta: CommandMeta): WorkView {
		this.requireActor(meta, "user");
		const prior = this.archive.findCommand(meta.commandId);
		if (prior !== undefined) {
			return prior.projection;
		}
		const workId = input.workId?.trim() || nanoid();
		const existing = this.archive.project(workId);
		if (existing !== undefined) {
			throw this.error("invalid-input", `Work ID ${workId} is already in use.`, false, "Choose a new Work ID.");
		}
		if (meta.expectedWorkRevision !== 0) {
			throw this.error(
				"revision-conflict",
				"A new Work must use revision zero.",
				false,
				"Retry with expected_work_revision 0.",
			);
		}
		const terms = normalizeTerms(input, this.options.defaultWorkTokens);
		const projection: WorkView = {
			workId,
			revision: 1,
			state: "submitted",
			terms,
			budget: { maxTokens: terms.maxTokens, reservedTokens: 0, consumedTokens: 0 },
			missionSpecificity: rawMissionSpecificity(input),
			nextAction: "Conclave admission is pending.",
			queuedSequence: 0,
		};
		const result = this.append({
			meta,
			kind: "submission",
			workId,
			payload: terms,
			projection,
			summary: `Work submitted: ${terms.title}`,
			effects: [{ effectId: `conclave-wake:${workId}`, kind: "conclave-wake", payload: { workId } }],
		});
		return result.projection;
	}

	listWork(): readonly WorkSummary[] {
		const projects = this.archive.listProjects();
		const queue = projects
			.filter((work) => work.state === "queued")
			.sort((a, b) => a.queuedSequence - b.queuedSequence);
		const queuePositions = new Map(queue.map((work, index) => [work.workId, index + 1]));
		// oxlint-disable-next-line complexity
		return projects.map((work) => ({
			workId: work.workId,
			title: work.terms.title,
			state: work.state,
			stopReason: work.stopReason,
			missionState: work.missionState,
			executionState: work.execution?.state,
			hasFailure:
				work.lastError !== undefined ||
				(work.state === "stopped" && work.stopReason === "failed") ||
				work.execution?.state === "failed",
			revision: work.revision,
			queuePosition: queuePositions.get(work.workId),
			budget: work.budget,
			nextAction: work.nextAction,
		}));
	}

	inspectWork(workId: string): WorkView {
		const work = this.archive.project(workId);
		if (work === undefined) {
			throw this.error(
				"not-found",
				`Work ${workId} was not found.`,
				false,
				"Read the Work list and choose an existing ID.",
			);
		}
		return work;
	}

	// oxlint-disable-next-line complexity
	async inspectRuntime(workId: string, meta?: CommandMeta): Promise<WorkView> {
		const work = this.inspectWork(workId);
		if (meta !== undefined) {
			this.requireReadableActor(meta.actor);
			this.checkRevision(work, meta);
			if (meta.actor !== "user") this.requireRoleBinding(meta, work);
		}
		const execution = work.execution;
		if (execution?.pi === undefined || (execution.state !== "running" && execution.state !== "awaiting-review")) {
			return work;
		}
		const runtimeState: RuntimeState = await this.ports.runtime.getState(execution.pi);
		const nextAction = runtimeAction(work, runtimeState);
		if (execution.runtimeState === runtimeState && nextAction === work.nextAction) return work;
		return {
			...work,
			execution: { ...execution, runtimeState },
			nextAction,
		};
	}

	async runAutonomousCycle(): Promise<void> {
		if (this.closing) return;
		if (this.autonomousCycleRun !== undefined) return this.autonomousCycleRun;
		const run = this.runAutonomousCycleOnce();
		this.autonomousCycleRun = run;
		try {
			await run;
		} finally {
			if (this.autonomousCycleRun === run) this.autonomousCycleRun = undefined;
		}
	}

	// oxlint-disable-next-line complexity
	private async runAutonomousCycleOnce(): Promise<void> {
		const bucket = Math.floor(Date.now() / AUTONOMOUS_MONITOR_INTERVAL_MS);
		for (const item of this.archive.listProjects()) {
			let work = this.inspectWork(item.workId);
			if (shouldMonitorProvider(work)) {
				try {
					work = await this.pollProvider(work.workId, monitorMeta(work, "provider", bucket));
				} catch (error) {
					if (!(error instanceof RevisionConflict))
						this.recordMonitorFailure(work, "Provider", error instanceof Error ? error : new Error(String(error)));
				}
			}
			work = this.inspectWork(item.workId);
			if (isProviderOutcomeSettlementPending(work)) {
				try {
					work = this.queueProviderOutcomeWake(work);
				} catch (error) {
					if (!(error instanceof RevisionConflict))
						this.recordMonitorFailure(
							work,
							"Provider outcome reconciliation",
							error instanceof Error ? error : new Error(String(error)),
						);
				}
			}
			const execution = work.execution;
			if (execution?.pi !== undefined && (execution.state === "running" || execution.state === "awaiting-review")) {
				try {
					const observed = await this.inspectRuntime(work.workId);
					const runtimeState = observed.execution?.runtimeState;
					if (runtimeState !== undefined && runtimeState !== execution.runtimeState)
						this.recordExecutorRuntimeState(work, runtimeState, runtimeState === "unreachable");
				} catch (error) {
					if (!(error instanceof RevisionConflict))
						this.recordMonitorFailure(
							work,
							"Executor runtime",
							error instanceof Error ? error : new Error(String(error)),
						);
				}
			}
		}
		await this.processPendingEffects();
	}

	// oxlint-disable-next-line complexity
	readRecords(query: RecordQuery | undefined, meta: CommandMeta, cursor?: string): Page<RecordView> {
		this.requireReadableActor(meta.actor);
		const capability = meta.actor === "user" || meta.actor === "monitor" ? undefined : this.requireCapability(meta);
		if (capability !== undefined && capability.role !== meta.actor)
			throw this.error(
				"forbidden",
				"The role capability does not match the actor.",
				false,
				"Use the bound role session.",
			);
		if (capability !== undefined && ["conclave", "executor", "observer"].includes(meta.actor))
			this.requireScopedCapability(meta, capability, this.inspectWork(capability.workId ?? ""));
		const normalized = this.normalizeRecordQuery(query, meta.actor, capability?.workId, capability?.executionId);
		const page = this.archive.query(normalized, cursor);
		if (capability?.role !== "executor") return page;
		if (capability.executionId === undefined)
			throw this.error(
				"forbidden",
				"The Executor capability is missing its Execution scope.",
				false,
				"Use the bound Executor session.",
			);
		const items = page.items.filter(
			(record) => record.executionId === undefined || record.executionId === capability.executionId,
		);
		let nextCursor = page.nextCursor;
		while (items.length < 100 && nextCursor !== undefined) {
			const nextPage = this.archive.query(normalized, nextCursor);
			items.push(
				...nextPage.items.filter(
					(record) => record.executionId === undefined || record.executionId === capability.executionId,
				),
			);
			nextCursor = nextPage.nextCursor;
		}
		return { ...page, items, nextCursor };
	}

	// oxlint-disable-next-line complexity
	availableActions(workId: string, actor: Actor, revision?: number, runtimeState?: RuntimeState): readonly Action[] {
		const work = this.inspectWork(workId);
		const expected = revision ?? work.revision;
		const actions: Action[] = [];
		const add = (kind: Action["kind"], enabled: boolean, label: string, disabledReason?: string): void => {
			actions.push(this.action(kind, work, expected, enabled, label, disabledReason));
		};
		const runtimeUnavailable =
			work.execution !== undefined &&
			(work.execution.state === "running" || work.execution.state === "awaiting-review") &&
			(runtimeState ?? work.execution.runtimeState) === "unreachable";
		if (actor === "user") {
			add(
				"amend-terms",
				work.mission === undefined && (work.state === "submitted" || work.state === "needs-input"),
				"Amend Work terms",
				work.mission === undefined ? undefined : "Admitted Mission terms are immutable.",
			);
			const cancellable = work.state === "stopped" && work.stopReason === "cancelled";
			const recoverable = cancellable || runtimeUnavailable;
			add(
				"recover",
				recoverable,
				"Recover Work",
				recoverable ? undefined : "Only stopped Work from cancellation or an unreachable runtime can be recovered.",
			);
			add(
				"rename-work",
				work.state !== "succeeded",
				"Rename Work",
				work.state === "succeeded" ? "Succeeded Work cannot be renamed." : undefined,
			);
			const terminal = ["succeeded", "stopped"].includes(work.state);
			add("fail-work", !terminal, "Fail Work", "Terminal Work cannot be failed again.");
			add("amend-budget", !terminal, "Amend Work budget", "Terminal Work cannot be amended.");
			add(
				"record-review",
				work.state === "awaiting-review",
				"Record provider review",
				work.state === "awaiting-review" ? undefined : "Work is not awaiting review.",
			);
			add("cancel", !terminal, "Cancel Work");
		}
		if (actor === "conclave") {
			add(
				"request-input",
				(work.state === "submitted" || work.state === "needs-input") && work.mission === undefined,
				"Request User input",
				work.mission === undefined ? undefined : "Mission terms are already admitted.",
			);
			const amendableMission =
				work.mission !== undefined &&
				!["succeeded", "stopped"].includes(work.state) &&
				(work.execution === undefined || ["failed", "stopped"].includes(work.execution.state));
			add(
				"amend-mission",
				amendableMission,
				"Amend Mission",
				amendableMission ? undefined : "The Mission is not amendable now.",
			);
			add(
				"recover",
				runtimeUnavailable,
				"Recover Executor runtime",
				runtimeUnavailable ? undefined : "Inspect the runtime before recovering it.",
			);
			add("admit", work.state === "submitted", "Admit Work");
			add(
				"fail-work",
				!["succeeded", "stopped"].includes(work.state),
				"Fail Work",
				"Terminal Work cannot be failed again.",
			);
			const observerReady =
				(work.state === "submitted" || work.state === "needs-input") &&
				work.terms.context.length === 0 &&
				work.observerInFlight !== true;
			add(
				"launch-observer",
				observerReady,
				"Gather missing repository context",
				observerReady ? undefined : "Work already contains context or an Observer is running.",
			);
			const missionActive = work.missionState === "admitted" || work.missionState === "active";
			const executionReady =
				(work.state === "queued" && work.mission !== undefined && work.execution === undefined) ||
				(work.state === "active" &&
					work.mission !== undefined &&
					work.execution !== undefined &&
					["failed", "blocked", "stopped"].includes(work.execution.state));
			add(
				"start-execution",
				missionActive && executionReady,
				"Start Execution",
				!missionActive
					? "The Mission is no longer active."
					: executionReady
						? undefined
						: "Work is not ready for an Execution.",
			);
			const currentSignal = isCurrentSignal(work);
			const budgetExhausted = work.execution?.blockReason === "budget-exhausted";
			add(
				"verdict",
				(currentSignal || budgetExhausted) &&
					(work.execution?.state === "running" || work.execution?.state === "blocked"),
				"Issue Verdict",
				currentSignal || budgetExhausted
					? "The current Execution is not awaiting a Verdict."
					: "No current Signal is available.",
			);
			const oracleInputsReady = isCurrentReadySignal(work) && isOpenReview(work.reviewRequest);
			const oracleReady = oracleInputsReady && work.execution?.state === "running";
			add(
				"run-oracle",
				oracleReady,
				"Run Oracle review",
				oracleReady
					? undefined
					: oracleInputsReady
						? "The current Execution is not running."
						: "Oracle review is available after a current ready Signal and open review request.",
			);
			add(
				"record-outcome",
				isProviderOutcomeSettlementPending(work),
				"Record Work Outcome",
				"Provider-confirmed merge evidence is required for active or awaiting-review Work.",
			);
			const observation = work.lastObservation;
			const feedbackReady =
				observation?.kind === "review-comment" &&
				(observation.feedback?.length ?? 0) > 0 &&
				work.execution?.pi !== undefined &&
				!this.hasFeedbackDelivery(work.workId, observation.observationId);
			add(
				"deliver-feedback",
				feedbackReady,
				"Deliver provider feedback",
				feedbackReady ? undefined : "No undelivered, actionable provider feedback is available.",
			);
		}
		if (actor === "executor") {
			add(
				"record-signal",
				work.execution?.state === "running",
				"Record Signal",
				"The current Execution is not running.",
			);
			add(
				"create-review-request",
				work.execution?.state === "running" && work.reviewRequest === undefined,
				"Create draft review request",
				"A running Execution without a review request is required.",
			);
		}
		return actions;
	}

	// oxlint-disable-next-line complexity
	async perform(command: ActionCommand): Promise<ServiceResult<WorkView>> {
		try {
			const prior = this.archive.findCommand(command.meta.commandId);
			if (prior !== undefined) {
				if (prior.record.workId !== command.workId) {
					throw this.error(
						"invalid-input",
						`Command ${command.meta.commandId} was already used for Work ${prior.record.workId}.`,
						false,
						"Use a new command ID for this Work.",
					);
				}
				return { value: prior.projection };
			}
			const value = await this.performOrThrow(command);
			return { value };
		} catch (error) {
			if (error instanceof ApplicationError) {
				return { error: error.envelope };
			}
			if (error instanceof ActionInputError) {
				return { error: this.inputEnvelope(error.message) };
			}
			return {
				error: {
					code: "external-failure",
					summary:
						error instanceof Error
							? `External Khala operation failed: ${error.message}`
							: "External Khala operation failed.",
					retryable: true,
					remediation: "Inspect the evidence, reconcile the runtime or provider, and retry explicitly.",
					evidenceRefs: [],
				},
			};
		}
	}

	private runInBackground(operation: Promise<void>): void {
		this.backgroundOperations.add(operation);
		void operation.finally(() => this.backgroundOperations.delete(operation)).catch(() => undefined);
	}

	// oxlint-disable-next-line complexity
	private async stopExecutorAfterTurn(
		work: WorkView,
		binding: RuntimeBinding,
		allowedStates: readonly Execution["state"][],
	): Promise<void> {
		const execution = work.execution;
		if (execution === undefined) return;
		const key = executorTurnKey(work.workId, execution.executionId);
		for (;;) {
			const activeTurns = this.activeExecutorTurns.get(key);
			if (activeTurns === undefined || activeTurns.size === 0) break;
			await Promise.all(activeTurns);
		}
		const current = this.archive.project(work.workId);
		const currentExecution = current?.execution;
		if (
			currentExecution === undefined ||
			currentExecution.executionId !== execution.executionId ||
			!allowedStates.includes(currentExecution.state) ||
			!sameRuntimeBinding(currentExecution.pi, binding)
		)
			return;
		await this.ports.runtime.requestStop(binding);
	}

	private addActiveExecutorTurn(key: string, turn: Promise<void>): void {
		const turns = this.activeExecutorTurns.get(key) ?? new Set<Promise<void>>();
		turns.add(turn);
		this.activeExecutorTurns.set(key, turns);
	}

	private removeActiveExecutorTurn(key: string, turn: Promise<void>): void {
		const turns = this.activeExecutorTurns.get(key);
		if (turns === undefined) return;
		turns.delete(turn);
		if (turns.size === 0) this.activeExecutorTurns.delete(key);
	}

	// oxlint-disable-next-line complexity
	private async wakeConclave(
		workId: string,
		commandId: string,
		observationId?: string,
		reason?: string,
	): Promise<void> {
		const work = this.inspectWork(workId);
		this.validateModel("conclave", this.options.conclaveModel, this.options.conclaveThinking);
		const binding = await this.ports.runtime.ensureSession({
			cwd: this.options.projectPath,
			model: this.options.conclaveModel,
			thinking: this.options.conclaveThinking,
			role: "conclave",
			promptIdentity: this.options.conclavePromptIdentity,
			bindingScope: { workId },
			tools: ["khala_read_archive", "khala_inspect_runtime", "khala_perform_action", "khala_run_oracle"],
		});
		try {
			const message =
				reason === "runtime-unreachable"
					? `Inspect the Executor runtime for Work ${work.workId}. If it is unreachable, use khala_perform_action with recover; keep the same Execution and do not ask the User to intervene.`
					: reason === "provider-outcome"
						? `Process the provider merge outcome for Work ${work.workId}. Read the Archive first. If the current review request and provider outcome both confirm the reviewed head was merged, use khala_perform_action with action record-outcome. The provider observation is evidence; only the explicit Conclave Outcome settles the Work.`
						: observationId !== undefined
							? `Process provider observation ${observationId} for Work ${work.workId}. Read the Archive, assess whether it fits the Mission, and use deliver-feedback with this observation ID only for bounded, actionable changes.`
							: work.lastObservation?.kind === "review-comment"
								? `Process new provider feedback for Work ${work.workId}. Read the Archive, assess whether it fits the Mission, and use deliver-feedback only for bounded, actionable changes.`
								: `Process queued Work ${work.workId}. Read the Archive first. Admit it if its Mission terms are complete, request-input when User intent is insufficient, then start its Execution when budget permits. Never treat this message as authority.`;
			await this.ports.runtime.send(binding, message);
			this.heartbeat.set(commandId, `Conclave wake sent for Work ${work.workId}.`);
		} finally {
			await this.ports.runtime.requestStop(binding).catch(() => undefined);
		}
	}

	async processPendingEffects(): Promise<void> {
		if (this.closing) return;
		if (this.pendingEffectsRun !== undefined) {
			this.pendingEffectsRequested = true;
			return this.pendingEffectsRun;
		}
		const run = this.drainPendingEffectsUntilIdle();
		this.pendingEffectsRun = run;
		try {
			await run;
		} finally {
			if (this.pendingEffectsRun === run) this.pendingEffectsRun = undefined;
		}
	}

	private async drainPendingEffectsUntilIdle(): Promise<void> {
		do {
			this.pendingEffectsRequested = false;
			await this.drainPendingEffects();
		} while (this.pendingEffectsRequested && !this.closing);
	}

	// oxlint-disable-next-line complexity
	private async drainPendingEffects(): Promise<void> {
		if (this.closing) return;
		const owner = `khala-worker:${randomUUID()}`;
		const retriedConclaveWakes = new Set<string>();
		for (;;) {
			const effects = this.archive.pendingEffects(owner);
			if (effects.length === 0) return;
			let unsupportedEffect = false;
			for (const effect of effects) {
				if (!SUPPORTED_EFFECT_KINDS.has(effect.kind)) {
					this.archive.releaseEffect(effect.effectId, owner);
					unsupportedEffect = true;
					continue;
				}
				let workId: string | undefined;
				let observationId: string | undefined;
				let wakeReason: string | undefined;
				let leaseLost = false;
				const lease = setInterval(() => {
					try {
						if (!this.archive.renewEffect(effect.effectId, owner)) leaseLost = true;
					} catch {
						leaseLost = true;
					}
				}, 60_000);
				try {
					workId = readEffectWorkId(effect.payload);
					observationId = readOptionalEffectText(effect.payload, "observationId");
					wakeReason = readOptionalEffectText(effect.payload, "reason");
					const work = this.inspectWork(workId);
					if (effect.kind === "conclave-wake") {
						await this.wakeConclave(workId, `outbox:${effect.effectId}:${work.revision}`, observationId, wakeReason);
					} else if (effect.kind === "scheduler-wake") {
						const activeCount = this.archive
							.listProjects()
							.filter(
								(candidate) => candidate.execution?.state === "running" || candidate.execution?.state === "queued",
							).length;
						if (activeCount < this.options.maxConcurrentExecutions) {
							const nextQueued = this.archive
								.listProjects()
								.filter(
									(candidate) =>
										candidate.state === "queued" &&
										candidate.mission !== undefined &&
										(candidate.missionState === "admitted" || candidate.missionState === "active"),
								)
								.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
							if (nextQueued !== undefined) {
								workId = nextQueued.workId;
								await this.wakeConclave(nextQueued.workId, `outbox:${effect.effectId}:${nextQueued.revision}`);
							}
						}
					} else if (effect.kind === "workspace-cleanup") {
						const binding = readOptionalEffectBinding(effect.payload);
						if (binding !== undefined)
							await this.stopExecutorAfterTurn(work, binding, ["completed", "failed", "stopped"]);
						await this.ports.workspace.removeSandbox(readCleanupSandbox(effect.payload));
					} else if (effect.kind === "observer-cleanup") {
						const binding = readEffectBinding(effect.payload);
						if (work.observer === undefined || sameRuntimeBinding(work.observer, binding))
							await this.ports.runtime.requestStop(binding);
					} else if (effect.kind === "executor-stop") {
						const binding = readEffectBinding(effect.payload);
						const executionId = readEffectExecutionId(effect.payload);
						if (
							work.execution?.executionId === executionId &&
							work.execution.state === "awaiting-review" &&
							sameRuntimeBinding(work.execution.pi, binding)
						)
							await this.stopExecutorAfterTurn(work, binding, ["awaiting-review"]);
					} else if (effect.kind === "executor-recovery") {
						const executionId = readEffectExecutionId(effect.payload);
						if (
							work.execution?.executionId === executionId &&
							work.execution.runtimeState === "pending" &&
							(work.execution.state === "running" || work.execution.state === "awaiting-review")
						) {
							await this.recoverExecutorRuntime(work, {
								actor: "system",
								commandId: `outbox:${effect.effectId}`,
								expectedWorkRevision: work.revision,
								schemaVersion: 1,
							});
						}
					} else if (effect.kind === "feedback-wake") {
						const feedback = readEffectFeedback(effect.payload);
						if (work.execution?.state === "running") {
							await this.resumeExecutor(work, feedback, effect.effectId, observationId);
						} else if (!["succeeded", "stopped"].includes(work.state)) {
							this.recordFeedbackUnavailable(work, feedback, effect.effectId, observationId);
							throw new Error("The Executor is not running; feedback delivery remains pending.");
						} else {
							this.recordFeedbackSuperseded(work, feedback, effect.effectId, observationId);
						}
					} else if (effect.kind === "executor-wake") {
						if (work.execution?.state === "queued") {
							await this.launchQueuedExecution(work, {
								actor: "system",
								commandId: `outbox:${effect.effectId}`,
								expectedWorkRevision: work.revision,
								schemaVersion: 1,
							});
						} else if (work.execution?.state === "running") {
							await this.driveExecutor(work);
						}
					} else if (effect.kind === "observer-wake" && work.observerInFlight === true && work.observer === undefined) {
						await this.launchObserverRuntime(work, {
							actor: "system",
							commandId: `outbox:${effect.effectId}`,
							expectedWorkRevision: work.revision,
							schemaVersion: 1,
						});
					} else if (work.execution?.state === "queued") {
						await this.launchQueuedExecution(work, {
							actor: "system",
							commandId: `outbox:${effect.effectId}`,
							expectedWorkRevision: work.revision,
							schemaVersion: 1,
						});
					}
					if (effect.kind === "conclave-wake" && wakeReason === "provider-outcome" && workId !== undefined) {
						const current = this.inspectWork(workId);
						if (isProviderOutcomeSettlementPending(current))
							throw new Error("Conclave provider-outcome wake returned without recording the Work Outcome.");
					}
					if (effect.kind === "conclave-wake" && work.state === "submitted" && work.revision === 1) {
						const current = this.inspectWork(work.workId);
						if (current.revision === work.revision)
							throw new Error("Conclave wake returned without recording a durable decision.");
					}
					if (leaseLost || !this.archive.completeEffect(effect.effectId, owner))
						throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
					clearInterval(lease);
				} catch (error) {
					clearInterval(lease);
					// A child can exit during startup before the first RPC response. Retry this
					// idempotent transport wake once in the same worker pass, then retain the
					// pending effect and durable error for the autonomous monitor to revisit.
					if (
						effect.kind === "conclave-wake" &&
						!(error instanceof ApplicationError) &&
						isTransientConclaveWakeFailure(error instanceof Error ? error.message : String(error)) &&
						!retriedConclaveWakes.has(effect.effectId)
					) {
						retriedConclaveWakes.add(effect.effectId);
						this.archive.releaseEffect(effect.effectId, owner);
						continue;
					}
					if (
						effect.kind === "executor-wake" &&
						workId !== undefined &&
						this.archive.project(workId)?.execution?.state !== "queued"
					)
						this.pendingEffectsRequested = true;
					if (effect.kind === "workspace-cleanup") {
						this.archive.releaseEffect(effect.effectId, owner);
						return;
					}
					if (effect.kind === "feedback-wake") {
						this.archive.releaseEffect(effect.effectId, owner);
						return;
					}
					if (effect.kind === "observer-wake" && workId !== undefined) {
						try {
							const current = this.inspectWork(workId);
							if (current.observerInFlight === true) {
								const next: WorkView = {
									...current,
									revision: current.revision + 1,
									observerInFlight: false,
									nextAction: "Observer failed; Conclave may retry.",
								};
								this.append({
									meta: {
										actor: "system",
										commandId: `observer-failure:${effect.effectId}:${current.revision}`,
										expectedWorkRevision: current.revision,
										schemaVersion: 1,
									},
									kind: "error",
									workId,
									payload: { message: error instanceof Error ? error.message : String(error) },
									projection: next,
									summary: "Observer runtime failed.",
									effects: observerEffects(workId, next.revision, current.observer),
								});
							}
						} catch {
							// Recovery preserves the reservation if its failure cannot be recorded.
						}
					}
					if (effect.kind === "conclave-wake" && workId !== undefined) {
						try {
							const current = this.inspectWork(workId);
							if (current.state === "succeeded" || current.state === "stopped") {
								if (!this.archive.completeEffect(effect.effectId, owner))
									throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
							} else {
								this.archive.releaseEffect(effect.effectId, owner);
								this.recordWakeFailure(
									workId,
									error instanceof Error ? error : new Error(String(error)),
									{
										actor: "conclave",
										commandId: `outbox-failure:${effect.effectId}:${current.revision}`,
										expectedWorkRevision: current.revision,
										schemaVersion: 1,
									},
									wakeReason,
								);
							}
						} catch {
							// Preserve the pending effect when its Work cannot be reconciled.
							this.archive.releaseEffect(effect.effectId, owner);
						}
					} else {
						this.archive.releaseEffect(effect.effectId, owner);
					}
					return;
				}
			}
			if (unsupportedEffect) return;
		}
	}

	// oxlint-disable-next-line complexity
	async pollProvider(workId: string, meta: CommandMeta): Promise<WorkView> {
		this.requireAnyActor(meta, ["user", "monitor"]);
		let work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		if (work.reviewRequest === undefined)
			throw this.error(
				"invalid-state",
				"Provider polling requires a review request.",
				false,
				"Publish a draft review request first.",
			);
		const observations = [...(await this.ports.codeHost.poll(work.reviewRequest))];
		const capabilities = await this.ports.codeHost.capabilities();
		const outcome = capabilities.supportsMergeObservation
			? await this.ports.codeHost.inspectOutcome(work.reviewRequest)
			: undefined;
		if (outcome !== undefined) observations.push(outcome);
		for (const [index, observation] of observations.entries()) {
			work = this.recordObservation(
				workId,
				observation,
				`${meta.commandId}:${index}`,
				work.revision,
				providerPollAuthority,
			);
		}
		if (work.lastError !== undefined && isProviderMonitorError(work.lastError)) {
			work = this.recordProviderPollRecovery(work, observations[0], `${meta.commandId}:recovered`);
		}
		return work;
	}

	// oxlint-disable-next-line complexity
	private async authorizeExecutorRecovery(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		// Conclave sessions hold verification authority only; the parent must own governed child launches.
		this.requireActor(meta, "conclave");
		const execution = work.execution;
		if (
			execution === undefined ||
			execution.pi === undefined ||
			(execution.state !== "running" && execution.state !== "awaiting-review")
		) {
			throw this.error(
				"invalid-state",
				"No recoverable Executor runtime is bound to this Work.",
				false,
				"Inspect the current Execution before recovering it.",
			);
		}
		if ((await this.ports.runtime.getState(execution.pi)) !== "unreachable") {
			throw this.error(
				"invalid-state",
				"The Executor runtime is currently reachable and does not need recovery.",
				false,
				"Inspect the current runtime state before recovering it.",
			);
		}
		const nextExecution: Execution = { ...execution, runtimeState: "pending" };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: nextExecution,
			lastError: undefined,
			nextAction: "Conclave authorized parent Executor recovery.",
		};
		return this.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: "Conclave authorized parent Executor recovery.",
			effects: [executorRecoveryEffect(work.workId, next.revision, execution.executionId)],
		}).projection;
	}

	// oxlint-disable-next-line complexity
	async recoverWork(
		workId: string,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): Promise<WorkView> {
		this.requireAnyActor(meta, ["user", "conclave"]);
		onRecoveryUpdate?.({ stage: "checking", message: "Checking the current Work state." });
		const work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		if (["succeeded", "stopped"].includes(work.state)) return work;
		if (work.observerInFlight === true && work.observer === undefined) {
			onRecoveryUpdate?.({ stage: "restoring", message: "Restoring the Work's pending assessment." });
			await this.processPendingEffects();
			const reconciled = this.inspectWork(workId);
			if (reconciled.observerInFlight !== true || reconciled.observer !== undefined) return reconciled;
			const next: WorkView = {
				...reconciled,
				revision: reconciled.revision + 1,
				observerInFlight: false,
				nextAction: "Observer reservation was reconciled; Conclave may retry.",
			};
			return this.append({
				meta: {
					...meta,
					commandId: `${meta.commandId}:observer-reservation`,
					expectedWorkRevision: reconciled.revision,
				},
				kind: "error",
				workId,
				payload: { message: "Observer reservation had no persisted runtime binding." },
				projection: next,
				summary: "Observer reservation was reconciled.",
			}).projection;
		}
		if (work.observerInFlight === true && work.observer !== undefined) {
			onRecoveryUpdate?.({ stage: "checking", message: "Checking the Work's current assessment." });
			const observerState = await this.ports.runtime.getState(work.observer);
			if (observerState === "working") return work;
			this.validateModel("observer", this.options.observerModel, this.options.observerThinking);
			let current = work;
			let shouldResume = observerState === "idle";
			if (observerState === "unreachable") {
				onRecoveryUpdate?.({ stage: "stopping", message: "Closing the unavailable assessment safely." });
				await this.ports.runtime.requestStop(work.observer).catch(() => undefined);
				onRecoveryUpdate?.({ stage: "restoring", message: "Restoring the Work's assessment." });
				const rebound = {
					...(await this.ports.runtime.ensureSession({
						cwd: this.options.projectPath,
						model: this.options.observerModel,
						thinking: this.options.observerThinking,
						role: "observer",
						promptIdentity: this.options.observerPromptIdentity,
						bindingScope: { workId },
						tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
						sessionPath: work.observer.sessionPath,
					})),
					promptIdentity: this.options.observerPromptIdentity,
				};
				try {
					current = this.append({
						meta: { ...meta, commandId: `${meta.commandId}:observer`, expectedWorkRevision: work.revision },
						kind: "execution",
						workId,
						payload: rebound,
						projection: { ...work, revision: work.revision + 1, observer: rebound },
						summary: "Observer runtime was reattached.",
					}).projection;
				} catch (error) {
					await this.ports.runtime.requestStop(rebound).catch(() => undefined);
					throw error;
				}
				shouldResume = true;
			}
			const binding = current.observer;
			if (binding === undefined) return current;
			if (shouldResume) {
				this.runInBackground(this.driveObserver(current, binding));
			}
			return current;
		}
		if (meta.actor === "conclave") return this.authorizeExecutorRecovery(work, meta);
		return this.recoverExecutorRuntime(work, meta, onRecoveryUpdate);
	}

	// oxlint-disable-next-line complexity
	private async recoverExecutorRuntime(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): Promise<WorkView> {
		if (work.mission === undefined || work.execution === undefined) return work;
		const execution = work.execution;
		if (execution.state === "queued") {
			await this.processPendingEffects();
			return this.inspectWork(work.workId);
		}
		if (execution.pi === undefined || !["running", "awaiting-review"].includes(execution.state)) return work;
		onRecoveryUpdate?.({ stage: "checking", message: "Checking the Work's Executor connection." });
		const executorState = await this.ports.runtime.getState(execution.pi);
		if (executorState === "working") return this.recordExecutorRuntimeState(work, "working");
		if (executorState === "idle") {
			if (execution.state === "running") {
				this.runInBackground(this.driveExecutor(work));
				return work;
			}
			return execution.runtimeState === "idle" ? work : this.recordExecutorRuntimeState(work, "idle");
		}
		if (executorState !== "unreachable") return work;
		onRecoveryUpdate?.({ stage: "stopping", message: "Closing the unavailable Work attempt safely." });
		const activeTurns = this.activeExecutorTurns.get(executorTurnKey(work.workId, execution.executionId));
		if (activeTurns === undefined || activeTurns.size === 0)
			await this.ports.runtime.requestStop(execution.pi).catch(() => undefined);
		onRecoveryUpdate?.({ stage: "restoring", message: "Restoring the Work's Executor." });
		this.validateModel("executor", execution.model, execution.thinking);
		let rebound: RuntimeBinding | undefined;
		try {
			rebound = await this.ports.runtime.ensureSession({
				cwd: execution.sandbox.path,
				model: execution.model,
				thinking: execution.thinking,
				role: "executor",
				promptIdentity: execution.promptIdentity,
				allowedPaths: work.terms.allowedPaths,
				sandboxRoot: execution.sandbox.path,
				bindingScope: { workId: work.workId, executionId: execution.executionId },
				tools: [
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"khala_read_archive",
					"khala_record_signal",
					"khala_perform_action",
				],
				sessionPath: execution.pi.sessionPath,
			});
			onRecoveryUpdate?.({ stage: "confirming", message: "Confirming the restored Work can continue." });
			if ((await this.ports.runtime.getState(rebound)) === "unreachable")
				throw new Error("The recovered Executor runtime is still unreachable.");
			const recovered: Execution = {
				...execution,
				pi: rebound,
				runtimeState: execution.state === "running" ? "pending" : "idle",
			};
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				lastError: undefined,
				execution: recovered,
				nextAction:
					execution.state === "running"
						? "Khala is continuing the Work automatically."
						: "Work is restored and awaiting review.",
			};
			onRecoveryUpdate?.({ stage: "finishing", message: "Saving the recovery result." });
			const result = this.append({
				meta,
				kind: "execution",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId: execution.executionId,
				payload: recovered,
				projection: next,
				summary: `Execution ${execution.executionId} runtime was reconciled.`,
			}).projection;
			if (execution.state === "running") this.runInBackground(this.driveExecutor(result));
			return result;
		} catch (error) {
			if (rebound !== undefined) await this.ports.runtime.requestStop(rebound).catch(() => undefined);
			const failed: Execution = {
				...execution,
				state: "failed",
				runtimeState: "unreachable",
				endedAt: new Date().toISOString(),
			};
			const failure = executionFailure(work, execution.executionId, error instanceof Error ? error : String(error));
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				execution: failed,
				budget: releaseExecutionReservation(work.budget, execution),
				lastError: failure,
				nextAction: "Execution runtime unavailable; replace it explicitly.",
			};
			return this.append({
				meta,
				kind: "error",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId: execution.executionId,
				payload: failure,
				projection: next,
				summary: `Execution ${execution.executionId} runtime could not be reconciled.`,
				effects: lifecycleEffects(work.workId, next.revision, failed),
			}).projection;
		}
	}

	// oxlint-disable-next-line complexity
	private recordObservation(
		workId: string,
		observation: ProviderObservation,
		commandId: string,
		expectedWorkRevision: number,
		authority: typeof providerPollAuthority,
	): WorkView {
		if (authority !== providerPollAuthority) throw new Error("Provider observations are internal to provider polling.");
		const prior = this.archive.findCommand(commandId);
		if (prior !== undefined) {
			if (prior.record.workId !== workId) {
				throw this.error(
					"invalid-input",
					`Command ${commandId} was already used for Work ${prior.record.workId}.`,
					false,
					"Use a new command ID for this Work.",
				);
			}
			return prior.projection;
		}
		const work = this.inspectWork(workId);
		const meta: CommandMeta = { actor: "monitor", commandId, expectedWorkRevision, schemaVersion: 1 };
		this.checkRevision(work, meta);
		if (work.reviewRequest === undefined || observation.providerId !== work.reviewRequest.providerId)
			throw this.error(
				"invalid-input",
				"Provider observation does not match the current review request.",
				false,
				"Poll the current provider review request.",
			);
		if (
			observation.kind === "provider-outcome" &&
			(observation.status !== "merged" ||
				observation.repository !== work.reviewRequest?.repository ||
				observation.sourceBranch !== work.reviewRequest?.sourceBranch ||
				observation.targetBranch !== work.reviewRequest?.targetBranch ||
				observation.headCommit !== work.reviewRequest?.headCommit ||
				observation.mergeCommit === undefined ||
				observation.mergeCommit.trim().length === 0)
		)
			throw this.error(
				"invalid-input",
				"Provider outcome evidence must report the merged reviewed head and merge commit.",
				false,
				"Use the provider adapter's confirmed merge observation.",
			);
		const key = observationKey(workId, observation);
		const fingerprint = observationFingerprint(observation);
		const previous = this.heartbeat.get(key) ?? this.persistedObservationFingerprint(work, observation);
		if (previous === fingerprint) {
			this.heartbeat.set(key, fingerprint);
			if (observation.kind === "provider-outcome") return this.queueProviderOutcomeWake(work);
			return work.lastError === undefined || !isProviderMonitorError(work.lastError)
				? work
				: this.recordProviderPollRecovery(work, observation, `${commandId}:recovered`);
		}
		let nextObservation: ProviderObservation = {
			...observation,
			changed: true,
			observedAt: new Date().toISOString(),
		};
		if (observation.feedback !== undefined) {
			nextObservation = { ...nextObservation, feedback: boundedFeedback(observation.feedback) };
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastObservation: nextObservation,
			lastError: work.lastError !== undefined && !isProviderMonitorError(work.lastError) ? work.lastError : undefined,
			providerOutcome: observation.kind === "provider-outcome" ? nextObservation : work.providerOutcome,
			reviewRequest:
				observation.kind === "provider-outcome"
					? { ...work.reviewRequest, status: "merged" }
					: observation.kind === "ci-status" && (observation.status === "closed" || observation.status === "merged")
						? { ...work.reviewRequest, status: observation.status }
						: work.reviewRequest,
			nextAction:
				observation.kind === "review-comment" && observation.actionable !== false
					? "Conclave is assessing provider feedback."
					: observation.status === "closed"
						? "Provider review is closed; Conclave is reconciling the Work."
						: observation.status === "merged"
							? "Provider merge observed; Conclave is recording the Outcome."
							: work.nextAction,
		};
		const result = this.append({
			meta,
			kind: "observation",
			workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: nextObservation,
			projection: next,
			summary: `Provider observation changed: ${observation.kind}.`,
			evidenceRefs: providerObservationEvidence(work, observation),
			effects:
				observation.kind === "provider-outcome" ||
				(observation.kind === "review-comment" && observation.actionable !== false) ||
				(observation.kind === "ci-status" && (observation.status === "closed" || observation.status === "merged"))
					? [
							schedulerEffect(
								workId,
								next.revision,
								observation.kind === "review-comment" ? observation.observationId : undefined,
								observation.kind === "review-comment"
									? "provider-feedback"
									: observation.kind === "ci-status" && observation.status === "closed"
										? "provider-closed"
										: observation.kind === "provider-outcome"
											? "provider-outcome"
											: undefined,
							),
						]
					: undefined,
		});
		if (work.lastError !== undefined && isProviderMonitorError(work.lastError))
			this.heartbeat.delete(monitorFailureMarker("Provider", work.workId));
		this.heartbeat.set(key, fingerprint);
		if (observation.kind === "provider-outcome" && isProviderOutcomeSettlementPending(result.projection))
			this.heartbeat.set(providerOutcomeWakeMarker(work.workId, observation.observationId), "queued");
		return result.projection;
	}

	// oxlint-disable-next-line complexity
	private recordProviderPollRecovery(
		work: WorkView,
		observation: ProviderObservation | undefined,
		commandId: string,
	): WorkView {
		const reviewRequest = work.reviewRequest;
		if (reviewRequest === undefined) return work;
		const providerId = reviewRequest.providerId;
		const recoveredObservation: ProviderObservation =
			observation === undefined
				? {
						observationId: `provider-monitor-recovered:${commandId}`,
						kind: "monitor-failure",
						providerId,
						status: "recovered",
						summary: "Provider polling succeeded; no new provider observations were reported.",
						changed: false,
						observedAt: new Date().toISOString(),
					}
				: {
						...observation,
						changed: false,
						observedAt: new Date().toISOString(),
						feedback: observation.feedback === undefined ? undefined : boundedFeedback(observation.feedback),
					};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastObservation: recoveredObservation,
			lastError: undefined,
			providerOutcome: recoveredObservation.kind === "provider-outcome" ? recoveredObservation : work.providerOutcome,
			reviewRequest:
				recoveredObservation.kind === "provider-outcome"
					? { ...reviewRequest, status: "merged" }
					: recoveredObservation.kind === "ci-status" &&
							(recoveredObservation.status === "closed" || recoveredObservation.status === "merged")
						? { ...reviewRequest, status: recoveredObservation.status }
						: reviewRequest,
			nextAction: providerPollRecoveryAction(work, recoveredObservation),
		};
		const result = this.append({
			meta: { actor: "monitor", commandId, expectedWorkRevision: work.revision, schemaVersion: 1 },
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: recoveredObservation,
			projection: next,
			summary:
				observation === undefined
					? recoveredObservation.summary
					: `Provider observation confirmed: ${recoveredObservation.kind}.`,
			evidenceRefs: providerObservationEvidence(work, recoveredObservation),
		});
		this.heartbeat.delete(monitorFailureMarker("Provider", work.workId));
		return result.projection;
	}

	// oxlint-disable-next-line complexity
	private queueProviderOutcomeWake(work: WorkView): WorkView {
		const outcome = work.providerOutcome;
		if (!isProviderOutcomeSettlementPending(work) || outcome === undefined) return work;
		const marker = providerOutcomeWakeMarker(work.workId, outcome.observationId);
		if (this.heartbeat.has(marker)) return work;
		const observation: ProviderObservation = { ...outcome, changed: false, observedAt: new Date().toISOString() };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastObservation: observation,
			nextAction: "Provider merge observed; Conclave is recording the Outcome.",
		};
		const result = this.append({
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

	// oxlint-disable-next-line complexity
	private recordWakeFailure(workId: string, failure: Error, meta: CommandMeta, reason?: string): WorkView {
		const work = this.inspectWork(workId);
		if (work.state === "succeeded" || work.state === "stopped") return work;
		this.checkRevision(work, meta);
		const feedbackWake = reason === "provider-feedback" || work.lastObservation?.kind === "review-comment";
		const runtimeWake = reason === "runtime-unreachable";
		const outcomeWake = reason === "provider-outcome";
		const error = conclaveWakeError(failure, feedbackWake, runtimeWake, outcomeWake);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastError: error,
			nextAction: runtimeWake
				? "Conclave could not inspect Executor recovery; retrying the autonomous inspection."
				: outcomeWake
					? "Conclave could not record the provider-confirmed Outcome; retrying settlement."
					: feedbackWake
						? "Conclave could not assess provider feedback; inspect Evidence before retrying delivery."
						: "Resolve the Conclave admission error, then retry admission.",
		};
		return this.append({
			meta,
			kind: "error",
			workId,
			payload: error,
			evidenceRefs: error.evidenceRefs,
			projection: next,
			summary: error.summary,
		}).projection;
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (this.monitorTimer !== undefined) clearInterval(this.monitorTimer);
		await this.waitForOperations();
		await this.ports.runtime.close();
		this.archive.close();
	}

	// oxlint-disable-next-line complexity
	private async waitForOperations(): Promise<void> {
		while (
			this.autonomousCycleRun !== undefined ||
			this.pendingEffectsRun !== undefined ||
			this.backgroundOperations.size > 0
		) {
			await Promise.allSettled([
				...(this.autonomousCycleRun === undefined ? [] : [this.autonomousCycleRun]),
				...(this.pendingEffectsRun === undefined ? [] : [this.pendingEffectsRun]),
				...this.backgroundOperations,
			]);
		}
	}

	// oxlint-disable-next-line complexity
	private persistedObservationFingerprint(work: WorkView, observation: ProviderObservation): string | undefined {
		const last = work.lastObservation;
		if (last?.kind === observation.kind && last.providerId === observation.providerId) {
			return sameObservation(last, observation) ? observationFingerprint(last) : undefined;
		}
		const previous = this.archive.findLatestObservation(
			work.workId,
			observation.kind,
			observation.providerId,
			observation.observationId,
		);
		return previous === undefined ? undefined : observationFingerprint(previous);
	}

	// oxlint-disable-next-line complexity
	private recordMonitorFailure(work: WorkView, subject: string, failure: Error): void {
		const message = failure.message.trim().slice(0, 2_000) || "The monitor returned no error detail.";
		const marker = monitorFailureMarker(subject, work.workId);
		if (this.heartbeat.get(marker) === message) return;
		let current = work;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const error: ErrorEnvelope = {
				code: "external-failure",
				source: subject === "Provider" ? "provider-monitor" : undefined,
				summary: `${subject} monitor failed: ${message}`,
				retryable: true,
				remediation: "Khala will retry automatically; inspect Evidence if the failure persists.",
				evidenceRefs: current.reviewRequest === undefined ? [] : [current.reviewRequest.providerId],
			};
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				lastError: error,
				nextAction: `${subject} monitor failed; retrying automatically.`,
			};
			try {
				this.append({
					meta: {
						actor: "monitor",
						commandId: `${marker}:${current.revision}`,
						expectedWorkRevision: current.revision,
						schemaVersion: 1,
					},
					kind: "error",
					workId: current.workId,
					missionId: current.mission?.missionId,
					executionId: current.execution?.executionId,
					payload: error,
					evidenceRefs: error.evidenceRefs,
					projection: next,
					summary: error.summary,
				});
				this.heartbeat.set(marker, message);
				return;
			} catch (appendError) {
				const revisionConflict =
					appendError instanceof RevisionConflict ||
					(appendError instanceof ApplicationError && appendError.envelope.code === "revision-conflict");
				if (!revisionConflict) throw appendError;
				const latest = this.archive.project(work.workId);
				if (latest === undefined) return;
				current = latest;
			}
		}
	}

	private recordServiceMonitorFailure(failure: Error): void {
		const work = this.archive.listProjects()[0];
		if (work === undefined) return;
		try {
			this.recordMonitorFailure(work, "Autonomous monitor", failure);
		} catch {
			// No durable Work target remains for this monitor failure.
		}
	}

	private hasFeedbackDelivery(workId: string, observationId: string, delivered?: boolean): boolean {
		let cursor: string | undefined;
		do {
			const page = this.archive.query({ workId, kinds: ["delivery"] }, cursor);
			if (
				page.items.some(
					(record) =>
						isJsonObject(record.payload) &&
						record.payload["observationId"] === observationId &&
						(delivered === undefined || record.payload["delivered"] === delivered),
				)
			)
				return true;
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		return false;
	}

	// oxlint-disable-next-line complexity
	private async performOrThrow(command: ActionCommand): Promise<WorkView> {
		const work = this.inspectWork(command.workId);
		this.checkRevision(work, command.meta);
		if (command.meta.actor !== "user") {
			this.requireRoleBinding(command.meta, work);
		}
		switch (command.action) {
			case "admit":
				return this.admit(work, command.meta);
			case "request-input":
				return this.requestInput(work, command.meta, command.input);
			case "amend-terms":
				return this.amendTerms(work, command.meta, command.input);
			case "amend-mission":
				return this.amendMission(work, command.meta, command.input);
			case "launch-observer":
				return this.launchObserver(work, command.meta);
			case "record-assessment":
				return this.recordAssessment(work, command.meta, command.input);
			case "start-execution":
				return this.startExecution(work, command.meta);
			case "record-signal":
				return this.recordSignal(work, command.meta, command.input);
			case "create-review-request":
				return this.createReviewRequest(work, command.meta);
			case "run-oracle":
				return this.runOracle(work, command.meta, command.input);
			case "verdict":
				return this.verdict(work, command.meta, command.input);
			case "deliver-feedback":
				return this.deliverFeedback(work, command.meta, command.input);
			case "record-review":
				return this.recordReview(work, command.meta, command.input);
			case "record-outcome":
				return this.recordOutcome(work, command.meta);
			case "cancel":
				return this.cancel(work, command.meta);
			case "recover":
				return work.state === "stopped" && work.stopReason === "cancelled"
					? this.recoverStopped(work, command.meta, command.onRecoveryUpdate)
					: this.recoverRuntime(work, command.meta, command.onRecoveryUpdate);
			case "rename-work":
				return this.renameWork(work, command.meta, command.input);
			case "amend-budget":
				return this.amendBudget(work, command.meta, command.input);
			case "fail-work":
				return this.failWork(work, command.meta, command.input);
		}
	}

	private requestInput(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "conclave");
		this.requirePreAdmissionWork(work, "User input can only be requested before admission.");
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const missing = readOptionalActionTextList(input?.missing, "missing");
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "needs-input",
			nextAction: `User input required: ${reason}`,
		};
		return this.append({
			meta,
			kind: "error",
			workId: work.workId,
			payload: { reason, missing },
			projection: next,
			summary: "Conclave requested additional User input.",
		}).projection;
	}

	private amendTerms(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "user");
		this.requirePreAdmissionWork(work, "Work terms can only change before admission.");
		const terms = mergeTermChanges(work.terms, input, false);
		const specificity = missionSpecificity(terms);
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
		return this.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			payload: { change: "terms", terms },
			projection: next,
			summary: "Work terms amended before Mission admission.",
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	private amendMission(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "conclave");
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
			lastError: undefined,
			nextAction: "Waiting for budget or project concurrency.",
			queuedSequence: 0,
		};
		return this.append({
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

	private requirePreAdmissionWork(work: WorkView, message: string): void {
		if (work.mission !== undefined || (work.state !== "submitted" && work.state !== "needs-input"))
			throw this.error("invalid-state", message, false, "Inspect the current Work state.");
	}

	private requireAmendableMission(work: WorkView): Mission {
		const mission = work.mission;
		if (mission === undefined)
			throw this.error("invalid-state", "Only an inactive Mission can be amended.", false, "Admit the Work first.");
		if (["succeeded", "stopped"].includes(work.state))
			throw this.error(
				"invalid-state",
				"Only an inactive Mission can be amended.",
				false,
				"Inspect the terminal Work.",
			);
		if (hasActiveExecution(work))
			throw this.error(
				"invalid-state",
				"Only an inactive Mission can be amended.",
				false,
				"End the current Execution before amending the Mission.",
			);
		return mission;
	}

	// oxlint-disable-next-line complexity
	private async launchObserver(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		if (work.state !== "submitted" && work.state !== "needs-input")
			throw this.error(
				"invalid-state",
				"Only submitted Work can launch an Observer.",
				false,
				"Inspect the current Work state.",
			);
		if (work.terms.context.length > 0 || work.observerInFlight === true)
			throw this.error(
				"invalid-state",
				"Work cannot launch another Observer.",
				false,
				"Admit the Work or reconcile the current Observer.",
			);
		if (this.options.observerModel.length === 0)
			throw this.error(
				"external-failure",
				"No Observer model is configured.",
				false,
				"Configure observerModel or provide the child Pi model explicitly.",
			);
		this.validateModel("observer", this.options.observerModel, this.options.observerThinking);
		const reserved: WorkView = {
			...work,
			revision: work.revision + 1,
			observerInFlight: true,
			nextAction: "Observer is inspecting the repository.",
		};
		return this.append({
			meta,
			kind: "execution",
			workId: work.workId,
			payload: { role: "observer", state: "reserved" },
			projection: reserved,
			summary: "Observer launch reserved.",
			effects: [observerEffect(work.workId, reserved.revision)],
		}).projection;
	}

	private async launchObserverRuntime(work: WorkView, meta: CommandMeta): Promise<void> {
		this.validateModel("observer", this.options.observerModel, this.options.observerThinking);
		const binding = {
			...(await this.ports.runtime.ensureSession({
				cwd: this.options.projectPath,
				model: this.options.observerModel,
				thinking: this.options.observerThinking,
				role: "observer",
				promptIdentity: this.options.observerPromptIdentity,
				bindingScope: { workId: work.workId },
				tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
				sessionPath: roleSessionPath(this.options.projectPath, "observer", work.workId),
			})),
			promptIdentity: this.options.observerPromptIdentity,
		};
		const bound: WorkView = {
			...work,
			revision: work.revision + 1,
			observer: binding,
			nextAction: "Observer assessment is pending.",
		};
		let current: WorkView;
		try {
			current = this.append({
				meta: { ...meta, commandId: `${meta.commandId}:binding`, expectedWorkRevision: work.revision },
				kind: "execution",
				workId: work.workId,
				payload: binding,
				projection: bound,
				summary: "Observer runtime is bound.",
			}).projection;
		} catch (error) {
			await this.ports.runtime.requestStop(binding).catch(() => undefined);
			throw error;
		}
		this.runInBackground(this.driveObserver(current, binding));
	}

	// oxlint-disable-next-line complexity
	private async driveObserver(work: WorkView, binding: RuntimeBinding): Promise<void> {
		const driveKey = observerDriveKey(work.workId, binding);
		if (this.drivingObservers.has(driveKey)) return;
		this.drivingObservers.add(driveKey);
		try {
			await this.ports.runtime.send(
				binding,
				`Inspect Work ${work.workId} read-only. Record exactly one bounded assessment with concrete repository evidence using Archive revision ${work.revision}, then stop.`,
			);
			const current = this.archive.project(work.workId);
			if (current?.observerInFlight === true && sameRuntimeBinding(current.observer, binding)) {
				const next: WorkView = {
					...current,
					revision: current.revision + 1,
					observer: undefined,
					observerInFlight: false,
					nextAction: "Observer completed without an assessment; Conclave may retry.",
				};
				this.append({
					meta: {
						actor: "system",
						commandId: `observer-empty:${current.workId}:${current.revision}`,
						expectedWorkRevision: current.revision,
						schemaVersion: 1,
					},
					kind: "error",
					workId: current.workId,
					payload: { message: "Observer completed without recording an assessment." },
					projection: next,
					summary: "Observer completed without an assessment.",
					effects: observerEffects(current.workId, next.revision, binding),
				});
			}
			queueMicrotask(() => void this.processPendingEffects());
		} catch (error) {
			const current = this.archive.project(work.workId);
			if (current?.observerInFlight !== true || !sameRuntimeBinding(current.observer, binding)) return;
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				observer: undefined,
				observerInFlight: false,
				nextAction: "Observer failed; Conclave may retry.",
			};
			try {
				this.append({
					meta: {
						actor: "system",
						commandId: `observer-runtime-failure:${current.workId}:${current.revision}`,
						expectedWorkRevision: current.revision,
						schemaVersion: 1,
					},
					kind: "error",
					workId: current.workId,
					payload: { message: error instanceof Error ? error.message : String(error) },
					projection: next,
					summary: "Observer runtime failed.",
					effects: observerEffects(current.workId, next.revision, binding),
				});
			} catch {
				if (binding !== undefined) await this.ports.runtime.requestStop(binding).catch(() => undefined);
			}
		} finally {
			this.drivingObservers.delete(driveKey);
		}
	}

	// oxlint-disable-next-line complexity
	private recordAssessment(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "observer");
		this.checkRevision(work, meta);
		if ((work.state !== "submitted" && work.state !== "needs-input") || work.observerInFlight !== true)
			throw this.error(
				"invalid-state",
				"No Observer assessment is currently authorized.",
				false,
				"Launch the Observer for this Work.",
			);
		const existing = this.archive.query({ workId: work.workId, kinds: ["assessment"] }).items;
		if (existing.length > 0)
			throw this.error(
				"invalid-state",
				"This Work already has an Observer assessment.",
				false,
				"Stop the Observer and let Conclave reread the Archive.",
			);
		const summary = requiredNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		const context =
			`${work.terms.context}\n\nRepository assessment:\n${summary}\nEvidence:\n${evidence.map((item) => `- ${item}`).join("\n")}`
				.trim()
				.slice(0, 16_000);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			terms: { ...work.terms, context },
			observer: undefined,
			observerInFlight: false,
			nextAction: "Conclave must reread the Observer assessment.",
		};
		return this.append({
			meta,
			kind: "assessment",
			workId: work.workId,
			payload: { summary, evidence },
			projection: next,
			summary: "Observer recorded one bounded repository assessment.",
			evidenceRefs: evidence,
			effects: observerEffects(work.workId, next.revision, work.observer),
		}).projection;
	}

	private admit(work: WorkView, meta: CommandMeta): WorkView {
		this.requireActor(meta, "conclave");
		if (work.state !== "submitted") {
			throw this.error(
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
		return this.append({
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

	// oxlint-disable-next-line complexity
	private async startExecution(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		if (
			work.mission === undefined ||
			(work.state !== "queued" && work.state !== "active") ||
			(work.missionState !== "admitted" && work.missionState !== "active")
		) {
			throw this.error(
				"invalid-state",
				"Only an active Mission can start an Execution.",
				false,
				"Admit the Work or create a new Mission.",
			);
		}
		if (work.execution !== undefined && ["queued", "running", "awaiting-review"].includes(work.execution.state))
			return work;
		const projects = this.archive.listProjects();
		const firstQueued = projects
			.filter((candidate) => candidate.state === "queued")
			.sort((a, b) => a.queuedSequence - b.queuedSequence)[0];
		if (work.state === "queued" && firstQueued !== undefined && firstQueued.workId !== work.workId) return work;
		const activeCount = projects.filter(
			(candidate) => candidate.execution?.state === "running" || candidate.execution?.state === "queued",
		).length;
		const allowance = Math.max(1, Math.floor(work.budget.maxTokens / 2));
		const availableBudget = work.budget;
		if (
			activeCount >= this.options.maxConcurrentExecutions ||
			availableBudget.reservedTokens + availableBudget.consumedTokens + allowance > availableBudget.maxTokens
		)
			return work;
		this.validateModel("executor", this.options.executorModel, this.options.executorThinking);
		const executionId = nanoid();
		const preflight = await this.ports.workspace.preflight(this.options.projectPath, this.options.targetBranch);
		const sandbox = await this.ports.workspace.ensureSandbox({
			workId: work.workId,
			executionId,
			mission: work.mission,
			projectPath: this.options.projectPath,
			baseCommit: preflight.headCommit,
		});
		const execution: Execution = {
			executionId,
			workId: work.workId,
			missionId: work.mission.missionId,
			state: "queued",
			pi: { sessionId: `pending:${executionId}`, sessionPath: join(sandbox.path, ".khala-executor-session.jsonl") },
			model: this.options.executorModel,
			thinking: this.options.executorThinking,
			tokenAllowance: allowance,
			promptIdentity: this.options.executorPromptIdentity,
			sandbox,
		};
		const queued: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "active",
			missionState: "active",
			budget: { ...availableBudget, reservedTokens: availableBudget.reservedTokens + allowance },
			reviewRequest: undefined,
			lastSignal: undefined,
			lastObservation: undefined,
			providerOutcome: undefined,
			execution,
			nextAction: "Executor is starting.",
		};
		let queuedResult: ReturnType<ApplicationService["append"]>;
		try {
			queuedResult = this.append({
				meta,
				kind: "execution",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId,
				payload: execution,
				projection: queued,
				summary: `Execution ${executionId} queued.`,
				effects: [executorEffect(work.workId, work.revision + 1)],
				executionGuard: {
					maxConcurrentExecutions: this.options.maxConcurrentExecutions,
					enforceFifo: work.state === "queued",
				},
			});
		} catch (error) {
			await this.reconcileSandboxCleanup(
				work.workId,
				executionId,
				sandbox,
				error instanceof Error ? error.message : String(error),
			);
			if (error instanceof ExecutionAdmissionConflict) return this.inspectWork(work.workId);
			throw error;
		}
		if (queuedResult.duplicate) await this.reconcileSandboxCleanup(work.workId, executionId, sandbox);
		return queuedResult.projection;
	}

	private async reconcileSandboxCleanup(
		workId: string,
		executionId: string,
		sandbox: Execution["sandbox"],
		reason?: string,
	): Promise<void> {
		try {
			await this.ports.workspace.removeSandbox(sandbox);
			return;
		} catch (error) {
			const current = this.inspectWork(workId);
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				nextAction: "Reserved sandbox cleanup is pending.",
			};
			this.append({
				meta: {
					actor: "system",
					commandId: `sandbox-cleanup:${executionId}:${current.revision}`,
					expectedWorkRevision: current.revision,
					schemaVersion: 1,
				},
				kind: "error",
				workId,
				payload: { executionId, message: reason ?? (error instanceof Error ? error.message : String(error)) },
				projection: next,
				summary: "Reserved sandbox cleanup was deferred to the outbox.",
				effects: [sandboxCleanupEffect(workId, executionId, sandbox)],
			});
		}
	}

	// oxlint-disable-next-line complexity
	private async launchQueuedExecution(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		const execution = this.requireExecution(work, "queued");
		let binding: RuntimeBinding | undefined;
		try {
			binding = await this.ports.runtime.ensureSession({
				cwd: execution.sandbox.path,
				model: execution.model,
				thinking: execution.thinking,
				role: "executor",
				promptIdentity: execution.promptIdentity,
				allowedPaths: work.terms.allowedPaths,
				sandboxRoot: execution.sandbox.path,
				bindingScope: { workId: work.workId, executionId: execution.executionId },
				tools: [
					"read",
					"bash",
					"edit",
					"write",
					"grep",
					"find",
					"ls",
					"khala_read_archive",
					"khala_record_signal",
					"khala_perform_action",
				],
				sessionPath: execution.pi?.sessionPath,
			});
			const running: Execution = {
				...execution,
				state: "running",
				runtimeState: "working",
				pi: binding,
				startedAt: new Date().toISOString(),
			};
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				execution: running,
				nextAction: "Executor is working.",
			};
			const result = this.append({
				meta: { ...meta, commandId: `${meta.commandId}:running`, expectedWorkRevision: work.revision },
				kind: "execution",
				workId: work.workId,
				missionId: work.mission?.missionId,
				executionId: execution.executionId,
				payload: running,
				projection: next,
				summary: `Execution ${execution.executionId} is running.`,
			}).projection;
			this.runInBackground(this.driveExecutor(result));
			return result;
		} catch (error) {
			if (binding !== undefined) await this.ports.runtime.requestStop(binding).catch(() => undefined);
			const failed: Execution = {
				...execution,
				state: "failed",
				blockReason: undefined,
				endedAt: new Date().toISOString(),
			};
			const failure = executionFailure(work, execution.executionId, error instanceof Error ? error : String(error));
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				budget: releaseExecutionReservation(work.budget, execution),
				execution: failed,
				lastError: failure,
				nextAction: "Execution failed; Conclave may replace it.",
			};
			this.append({
				meta: { ...meta, commandId: `${meta.commandId}:failed`, expectedWorkRevision: work.revision },
				kind: "error",
				workId: work.workId,
				missionId: work.mission?.missionId,
				executionId: execution.executionId,
				payload: failure,
				projection: next,
				summary: `Execution ${execution.executionId} failed to start.`,
				effects: lifecycleEffects(work.workId, next.revision, next.execution),
			});
			throw this.error(
				"external-failure",
				"The Executor runtime could not be started.",
				true,
				"Inspect the failure evidence and retry the Execution.",
			);
		}
	}

	// oxlint-disable-next-line complexity
	private async driveExecutor(work: WorkView): Promise<void> {
		const execution = work.execution;
		if (execution?.pi === undefined) return;
		const key = executionDriveKey(work.workId, execution);
		const turnKey = executorTurnKey(work.workId, execution.executionId);
		if (this.drivingExecutions.has(key)) return;
		let finish: () => void = () => undefined;
		const turn = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.drivingExecutions.set(key, turn);
		this.addActiveExecutorTurn(turnKey, turn);
		let activeBinding: RuntimeBinding | undefined;
		try {
			let current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				!sameRuntimeBinding(current.execution.pi, execution.pi)
			)
				return;
			current = this.recordExecutorRuntimeState(current, "working");
			const binding = current.execution?.pi;
			if (binding === undefined) return;
			activeBinding = binding;
			const result = await this.ports.runtime.send(
				binding,
				`Work ${current.workId}, Execution ${execution.executionId} is bound. Read the Archive, inspect the sandbox, implement the Mission, validate it, publish the draft review request, and send evidence-bearing Signals. The current Work revision is ${current.revision}.`,
			);
			this.recordExecutorTurn(current, result);
			queueMicrotask(() => void this.processPendingEffects());
		} catch (error) {
			await this.ports.runtime.requestStop(activeBinding ?? execution.pi).catch(() => undefined);
			const current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				!sameRuntimeBinding(current.execution.pi, activeBinding)
			)
				return;
			const failed: WorkView = {
				...current,
				revision: current.revision + 1,
				execution: {
					...current.execution,
					state: "failed",
					runtimeState: "unreachable",
					endedAt: new Date().toISOString(),
				},
				budget: releaseExecutionReservation(current.budget, execution),
				lastError: executionFailure(current, execution.executionId, error instanceof Error ? error : String(error)),
				nextAction: "Executor runtime failed; Conclave may replace it.",
			};
			try {
				this.append({
					meta: {
						actor: "system",
						commandId: `executor-failure:${execution.executionId}:${current.revision}`,
						expectedWorkRevision: current.revision,
						schemaVersion: 1,
					},
					kind: "error",
					workId: current.workId,
					missionId: current.mission?.missionId,
					executionId: execution.executionId,
					payload: failed.lastError ?? { message: "Executor runtime failed." },
					projection: failed,
					summary: "Executor runtime failed after launch.",
					effects: lifecycleEffects(current.workId, failed.revision, failed.execution),
				});
				void this.processPendingEffects();
			} catch {
				// Recovery rereads the unchanged currentness fence and records the failure explicitly.
			}
		} finally {
			finish();
			if (this.drivingExecutions.get(key) === turn) this.drivingExecutions.delete(key);
			this.removeActiveExecutorTurn(turnKey, turn);
		}
	}

	// oxlint-disable-next-line complexity
	private recordExecutorRuntimeState(work: WorkView, runtimeState: RuntimeState, wakeConclave = false): WorkView {
		const execution = work.execution;
		if (execution === undefined || execution.runtimeState === runtimeState) return work;
		const nextExecution: Execution = { ...execution, runtimeState };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: nextExecution,
			nextAction:
				runtimeState === "unreachable" && wakeConclave
					? "Executor runtime is unreachable. Conclave is inspecting recovery."
					: runtimeAction(work, runtimeState),
		};
		return this.append({
			meta: {
				actor: "system",
				commandId: `executor-runtime:${execution.executionId}:${work.revision}:${runtimeState}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "execution",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: `Executor runtime is ${runtimeState}.`,
			effects: wakeConclave
				? [schedulerEffect(work.workId, next.revision, undefined, "runtime-unreachable")]
				: undefined,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private recordExecutorTurn(work: WorkView, turn: RuntimeTurn): WorkView {
		const current = this.archive.project(work.workId);
		const execution = current?.execution;
		if (
			current === undefined ||
			execution === undefined ||
			execution.state !== "running" ||
			execution.executionId !== work.execution?.executionId ||
			!sameRuntimeBinding(execution.pi, work.execution?.pi)
		)
			return work;
		const usage = turn.usage === undefined ? execution.usage : addTokenUsage(execution.usage, turn.usage);
		const newSignal = current.lastSignal?.signalId !== work.lastSignal?.signalId;
		const exhausted = usage !== undefined && tokenUsageTotal(usage) >= execution.tokenAllowance;
		let nextExecution: Execution = {
			...execution,
			state: exhausted ? "blocked" : execution.state,
			blockReason: exhausted ? "budget-exhausted" : undefined,
			runtimeState: "idle",
		};
		if (usage !== undefined) nextExecution = { ...nextExecution, usage };
		const next: WorkView = {
			...current,
			revision: current.revision + 1,
			execution: nextExecution,
			budget: applyUsage(current.budget, execution.usage, usage),
			nextAction: exhausted
				? "Execution token allowance exhausted; Conclave must replace it or amend the Work budget."
				: execution.state === "running" && !newSignal
					? "Executor is idle; waiting for a Signal."
					: current.nextAction,
		};
		return this.append({
			meta: {
				actor: "system",
				commandId: `executor-turn:${execution.executionId}:${current.revision}`,
				expectedWorkRevision: current.revision,
				schemaVersion: 1,
			},
			kind: "execution",
			workId: current.workId,
			missionId: current.mission?.missionId,
			executionId: execution.executionId,
			payload: nextExecution,
			projection: next,
			summary: exhausted
				? `Execution ${execution.executionId} exhausted its token allowance.`
				: `Execution ${execution.executionId} turn completed; runtime is idle.`,
			effects: exhausted ? [schedulerEffect(current.workId, next.revision, undefined, "token-exhausted")] : undefined,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async recordSignal(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "executor");
		const execution = this.requireExecution(work, "running");
		const kind = readSignalKind(input);
		const summary = requiredNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		if (kind === "ready") {
			await this.ensureAllowedPaths(work, execution);
			const request = work.reviewRequest;
			if (
				request === undefined ||
				!isOpenReview(request) ||
				request.sourceBranch !== execution.sandbox.branch ||
				request.targetBranch !== this.options.targetBranch
			) {
				throw this.error(
					"invalid-state",
					"A ready Signal requires a review request for the current sandbox branch.",
					false,
					"Publish the current sandbox and create its draft review request.",
				);
			}
			const head = await this.ports.workspace.inspectHead(execution.sandbox.path);
			if (request.headCommit !== head || request.diffSummary.trim().length === 0 || request.validation.length === 0) {
				throw this.error(
					"invalid-state",
					"The review request does not contain current head, diff, and validation evidence.",
					false,
					"Reconcile the review request and rerun validation.",
				);
			}
		}
		const signal: Signal = {
			signalId: randomUUID(),
			executionId: execution.executionId,
			kind,
			summary,
			evidence,
			observedAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: kind === "blocked" ? { ...execution, state: "blocked", blockReason: "signal" } : execution,
			lastSignal: signal,
			nextAction: "Conclave assessment is pending.",
		};
		return this.append({
			meta,
			kind: "signal",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: signal,
			projection: next,
			summary: `${kind} Signal from Executor.`,
			evidenceRefs: evidence,
			effects:
				kind === "blocked"
					? [schedulerEffect(work.workId, next.revision), queueSchedulerEffect(work.workId, next.revision)]
					: kind === "ready"
						? [schedulerEffect(work.workId, next.revision)]
						: undefined,
		}).projection;
	}

	private async ensureAllowedPaths(work: WorkView, execution: Execution): Promise<void> {
		const inspectChanges = this.ports.workspace.inspectChanges;
		if (inspectChanges === undefined) return;
		const changedPaths = await inspectChanges({
			path: execution.sandbox.path,
			baseCommit: execution.sandbox.baseCommit,
		});
		const unauthorized = changedPaths.filter((path) => !isAllowedPath(path, work.terms.allowedPaths));
		if (unauthorized.length > 0)
			throw this.error(
				"invalid-state",
				`The sandbox contains changes outside the permitted paths: ${unauthorized.slice(0, 5).join(", ")}.`,
				false,
				"Revert changes outside the Mission paths before publishing or sending ready evidence.",
			);
	}

	// oxlint-disable-next-line complexity
	private async createReviewRequest(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "executor");
		const execution = this.requireExecution(work, "running");
		await this.ensureAllowedPaths(work, execution);
		if (work.mission === undefined) {
			throw this.error(
				"invalid-state",
				"A Mission is required before review publication.",
				false,
				"Ask the Conclave to admit Work.",
			);
		}
		const capabilities = await this.ports.codeHost.capabilities();
		if (!capabilities.supportsDraft)
			throw this.error(
				"external-failure",
				"The configured provider does not support draft review requests.",
				false,
				"Use a GitHub or GitLab provider with draft review support.",
			);
		const preflight = await this.ports.workspace.preflight(this.options.projectPath, this.options.targetBranch);
		if (preflight.headCommit !== execution.sandbox.baseCommit)
			throw this.error(
				"invalid-state",
				"The target branch changed since this Execution started.",
				false,
				"Rebase or replace the Execution before publishing its review request.",
			);
		const headCommit = await this.ports.workspace.inspectHead(execution.sandbox.path);
		if (
			work.reviewRequest !== undefined &&
			work.reviewRequest.headCommit === headCommit &&
			work.reviewRequest.sourceBranch === execution.sandbox.branch &&
			work.reviewRequest.targetBranch === this.options.targetBranch &&
			work.reviewRequest.diffSummary.trim().length > 0 &&
			work.reviewRequest.validation.length > 0
		)
			return work;
		if (headCommit === execution.sandbox.baseCommit) {
			throw this.error(
				"invalid-state",
				"The sandbox has no commit beyond its base.",
				false,
				"Implement and commit the Mission changes before publishing.",
			);
		}
		const publishedHead = await this.ports.workspace.publishSandbox(execution.sandbox);
		if (publishedHead !== headCommit) {
			throw this.error(
				"external-failure",
				"The published sandbox head changed unexpectedly.",
				true,
				"Reconcile the sandbox and review provider.",
			);
		}
		const request = await this.ports.codeHost.ensureReviewRequest({
			workId: work.workId,
			mission: work.mission,
			execution,
			terms: work.terms,
			sandbox: execution.sandbox,
			headCommit,
			targetBranch: this.options.targetBranch,
			draftMarker: `Khala-Work: ${work.workId}`,
		});
		if (
			request.sourceBranch !== execution.sandbox.branch ||
			request.targetBranch !== this.options.targetBranch ||
			request.headCommit !== headCommit
		) {
			throw this.error(
				"integrity-failure",
				"The provider review request does not match the published sandbox.",
				false,
				"Reconcile the provider request before sending a ready Signal.",
			);
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			reviewRequest: request,
			nextAction: "Executor may send a ready Signal.",
		};
		return this.append({
			meta,
			kind: "review-request",
			workId: work.workId,
			missionId: work.mission.missionId,
			executionId: execution.executionId,
			payload: request,
			projection: next,
			summary: `Draft ${request.provider} review request ${request.providerId} is ready.`,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async runOracle(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		if (
			work.mission === undefined ||
			!isCurrentReadySignal(work) ||
			work.execution?.state !== "running" ||
			!isOpenReview(work.reviewRequest)
		) {
			throw this.error(
				"invalid-state",
				"Oracle review requires a ready Signal and review request.",
				false,
				"Wait for Executor handoff evidence.",
			);
		}
		const mission = work.mission;
		const reviewRequest = work.reviewRequest;
		if (mission === undefined || reviewRequest === undefined) {
			throw this.error(
				"integrity-failure",
				"Oracle review bindings disappeared after validation.",
				false,
				"Reread the Work and recover the current Mission bindings.",
			);
		}
		this.validateModel("oracle", this.options.oracleModel, this.options.oracleThinking);
		const subject = requiredNonBlank(requiredText(input?.subject, "subject"), "subject");
		const result = await this.ports.oracle.review(
			{
				subject,
				mission,
				diff: reviewRequest.diffSummary,
				validation: reviewRequest.validation,
				providerEvidence: work.lastObservation === undefined ? [] : [work.lastObservation.summary],
			},
			this.options.oracleModel,
			this.options.oracleThinking,
		);
		const next: WorkView = { ...work, revision: work.revision + 1, nextAction: "Conclave must decide the Verdict." };
		return this.append({
			meta,
			kind: "oracle-review",
			workId: work.workId,
			missionId: mission.missionId,
			executionId: work.execution?.executionId,
			payload: oraclePayload(result, this.options.oraclePromptIdentity),
			projection: next,
			summary: `Oracle advisory result: ${result.verdict}.`,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async verdict(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		const execution = this.requireExecution(work);
		if (execution.state !== "running" && execution.state !== "blocked") {
			throw this.error(
				"invalid-state",
				"The current Execution is not awaiting a Verdict.",
				false,
				"Wait for a current Executor Signal.",
			);
		}
		const signal = work.lastSignal;
		const decision = readDecision(input);
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const signalId = requiredNonBlank(requiredText(input?.signalId, "signalId"), "signalId");
		if (decision === "continue" && execution.blockReason === "budget-exhausted")
			throw this.error(
				"budget-exhausted",
				"The Execution has exhausted its token allowance.",
				false,
				"Replace the Execution or amend the Work budget before continuing.",
			);
		const budgetExhausted = execution.blockReason === "budget-exhausted";
		if (
			(!budgetExhausted &&
				(signal === undefined || signal.executionId !== execution.executionId || signal.signalId !== signalId)) ||
			(budgetExhausted && signalId !== "budget-exhausted")
		) {
			throw this.error(
				"invalid-state",
				budgetExhausted
					? "A budget-exhausted Verdict must use signalId budget-exhausted."
					: "The Verdict must reference the current Signal.",
				false,
				"Read the latest Signal before deciding.",
			);
		}
		const verdictPayload = { decision, reason, signalId, executionId: execution.executionId };
		let nextExecution: Execution = execution;
		let nextState: WorkState = work.state;
		let nextMissionState: MissionState | undefined = work.missionState;
		let nextAction = "Verdict recorded.";
		if (decision === "continue") {
			nextExecution = { ...execution, state: "running", blockReason: undefined };
			nextState = "active";
			nextAction = "Executor continues.";
		} else if (decision === "handoff") {
			if (
				signal === undefined ||
				signal.kind !== "ready" ||
				!isOpenReview(work.reviewRequest) ||
				execution.state !== "running"
			) {
				throw this.error(
					"invalid-state",
					"Handoff requires a ready Signal and review request.",
					false,
					"Create review evidence before handoff.",
				);
			}
			nextExecution = { ...execution, state: "awaiting-review", blockReason: undefined };
			nextState = "awaiting-review";
			nextMissionState = "awaiting-review";
			nextAction = "Awaiting User review.";
		} else if (decision === "reject") {
			nextExecution = { ...execution, state: "failed", blockReason: undefined, endedAt: new Date().toISOString() };
			nextMissionState = "rejected";
			nextState = "active";
			nextAction = "Mission rejected; Conclave decision is required for Work closure.";
		} else {
			nextExecution = { ...execution, state: "stopped", blockReason: undefined, endedAt: new Date().toISOString() };
			nextState = "queued";
			nextAction = "Replacement Execution is queued under the same Mission.";
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: nextState,
			missionState: nextMissionState,
			lastSignal: decision === "continue" ? undefined : work.lastSignal,
			execution: nextExecution,
			budget: releaseExecutionReservation(work.budget, nextExecution),
			nextAction,
		};
		const result = this.append({
			meta,
			kind: "verdict",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: verdictPayload,
			projection: next,
			summary: `Conclave Verdict: ${decision}.`,
			effects:
				decision === "continue"
					? [executorEffect(work.workId, next.revision)]
					: lifecycleEffects(work.workId, next.revision, nextExecution),
		});
		if (decision !== "replace") {
			return result.projection;
		}
		return this.startExecution(result.projection, {
			...meta,
			commandId: `${meta.commandId}:replacement`,
			expectedWorkRevision: result.projection.revision,
		});
	}

	// oxlint-disable-next-line complexity
	private async recordReview(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "user");
		if (work.state !== "awaiting-review" || work.reviewRequest === undefined) {
			throw this.error("invalid-state", "Work is not awaiting a review.", false, "Wait for a handoff Verdict.");
		}
		const status = readReviewStatus(input);
		const feedback = input?.feedback === undefined ? [] : readTextList(input, "feedback");
		if (status === "changes-requested" && feedback.length === 0)
			throw this.error(
				"invalid-input",
				"Review feedback is required when changes are requested.",
				false,
				"Provide at least one concrete feedback item.",
			);
		const request = {
			...work.reviewRequest,
			status: status === "merged" ? "merged" : status === "closed" ? "closed" : "open",
		} as const;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			reviewRequest: request,
			lastSignal: status === "changes-requested" ? undefined : work.lastSignal,
			lastObservation: status === "changes-requested" ? undefined : work.lastObservation,
			providerOutcome: status === "changes-requested" ? undefined : work.providerOutcome,
			execution:
				work.execution === undefined
					? undefined
					: status === "changes-requested"
						? { ...work.execution, state: "running" }
						: work.execution,
			state: status === "changes-requested" ? "active" : "awaiting-review",
			missionState: status === "changes-requested" ? "active" : work.missionState,
			nextAction:
				status === "merged"
					? "Conclave must verify provider merge evidence and record the Outcome."
					: status === "changes-requested"
						? "Executor may address authorized review feedback."
						: "Review closed without acceptance.",
		};
		const result = this.append({
			meta,
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { status, feedback },
			projection: next,
			summary: `User review recorded: ${status}.`,
			evidenceRefs: feedback,
			effects:
				status === "changes-requested"
					? [feedbackEffect(work.workId, next.revision, undefined, feedback)]
					: [
							schedulerEffect(work.workId, next.revision),
							...(work.execution?.pi === undefined
								? []
								: [executorStopEffect(work.workId, next.revision, work.execution)]),
						],
		});
		return result.projection;
	}

	// oxlint-disable-next-line complexity
	private async deliverFeedback(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		const observationId = input?.observationId ?? work.lastObservation?.observationId;
		const observation =
			observationId === undefined ? work.lastObservation : this.archive.findObservation(work.workId, observationId);
		const execution = work.execution;
		const feedback = observation?.feedback ?? [];
		if (
			observation?.kind !== "review-comment" ||
			observation.actionable === false ||
			feedback.length === 0 ||
			execution === undefined ||
			execution.pi === undefined ||
			work.reviewRequest === undefined ||
			["succeeded", "stopped"].includes(work.state)
		)
			throw this.error(
				"invalid-state",
				"No actionable provider feedback is ready for delivery.",
				false,
				"Read the latest provider observation and wait for a review comment.",
			);
		if (this.hasFeedbackDelivery(work.workId, observation.observationId)) return work;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: { ...execution, state: "running" },
			state: "active",
			missionState: "active",
			lastSignal: undefined,
			nextAction: "Executor is resuming authorized provider feedback.",
		};
		return this.append({
			meta,
			kind: "delivery",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: { observationId: observation.observationId, feedback, delivered: false },
			projection: next,
			evidenceRefs: feedback,
			summary: "Conclave authorized provider review feedback.",
			effects: [feedbackEffect(work.workId, next.revision, observation.observationId, feedback)],
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async resumeExecutor(
		work: WorkView,
		feedback: readonly string[],
		deliveryId: string,
		observationId?: string,
	): Promise<void> {
		const execution = work.execution;
		if (execution?.pi === undefined) {
			this.recordFeedbackUnavailable(work, feedback, deliveryId, observationId);
			throw new Error("The Executor runtime is not bound; feedback delivery remains pending.");
		}
		const turnKey = executorTurnKey(work.workId, execution.executionId);
		const active = this.activeExecutorTurns.get(turnKey);
		if (active !== undefined) {
			await Promise.all(active);
			const latest = this.archive.project(work.workId);
			if (latest?.execution?.state === "running")
				return this.resumeExecutor(latest, feedback, deliveryId, observationId);
			if (latest !== undefined && ["succeeded", "stopped"].includes(latest.state))
				this.recordFeedbackSuperseded(latest, feedback, deliveryId, observationId);
			else if (latest !== undefined) this.recordFeedbackUnavailable(latest, feedback, deliveryId, observationId);
			throw new Error("The Executor turn ended before feedback delivery; retrying the same Execution.");
		}
		let finish: () => void = () => undefined;
		const turn = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.addActiveExecutorTurn(turnKey, turn);
		let activeBinding: RuntimeBinding = execution.pi;
		try {
			let current = work;
			let binding = activeBinding;
			if ((await this.ports.runtime.getState(binding)) === "unreachable") {
				await this.ports.runtime.requestStop(binding).catch(() => undefined);
				const rebound = await this.ports.runtime.ensureSession({
					cwd: execution.sandbox.path,
					model: execution.model,
					thinking: execution.thinking,
					role: "executor",
					promptIdentity: execution.promptIdentity,
					allowedPaths: work.terms.allowedPaths,
					sandboxRoot: execution.sandbox.path,
					bindingScope: { workId: work.workId, executionId: execution.executionId },
					tools: [
						"read",
						"bash",
						"edit",
						"write",
						"grep",
						"find",
						"ls",
						"khala_read_archive",
						"khala_record_signal",
						"khala_perform_action",
					],
					sessionPath: execution.pi.sessionPath,
				});
				try {
					const latest = this.inspectWork(work.workId);
					if (
						latest.execution?.executionId !== execution.executionId ||
						latest.execution.state !== "running" ||
						!sameRuntimeBinding(latest.execution.pi, execution.pi)
					) {
						await this.ports.runtime.requestStop(rebound).catch(() => undefined);
						if (latest !== undefined && ["succeeded", "stopped"].includes(latest.state))
							this.recordFeedbackSuperseded(latest, feedback, deliveryId, observationId);
						else if (latest !== undefined) this.recordFeedbackUnavailable(latest, feedback, deliveryId, observationId);
						throw new Error("Executor binding changed before feedback delivery; retrying the same Execution.");
					}
					current = this.append({
						meta: {
							actor: "system",
							commandId: `feedback-binding:${execution.executionId}:${latest.revision}`,
							expectedWorkRevision: latest.revision,
							schemaVersion: 1,
						},
						kind: "execution",
						workId: work.workId,
						missionId: latest.mission?.missionId,
						executionId: execution.executionId,
						payload: rebound,
						projection: {
							...latest,
							revision: latest.revision + 1,
							execution: { ...latest.execution, pi: rebound },
							nextAction: "Executor is resuming authorized review feedback.",
						},
						summary: "Executor runtime was reattached for review feedback.",
					}).projection;
				} catch (error) {
					await this.ports.runtime.requestStop(rebound).catch(() => undefined);
					throw error;
				}
				binding = current.execution?.pi ?? rebound;
			}
			activeBinding = binding;
			current = this.recordExecutorRuntimeState(current, "working");
			const result = await this.ports.runtime.send(
				activeBinding,
				`Review feedback delivery ${deliveryId} for Work ${current.workId} is authorized. Read the Archive and address only feedback that fits the Mission. If this delivery ID is already recorded in the Archive, do not repeat the change. Feedback:\n${feedback.map((item) => `- ${item}`).join("\n")}`,
			);
			this.recordExecutorTurn(current, result);
			if (
				observationId !== undefined &&
				!this.recordFeedbackDelivered(
					work.workId,
					observationId,
					feedback,
					deliveryId,
					execution.executionId,
					activeBinding,
				)
			) {
				const latest = this.archive.project(work.workId);
				if (latest !== undefined && ["succeeded", "stopped"].includes(latest.state))
					this.recordFeedbackSuperseded(latest, feedback, deliveryId, observationId);
				else if (latest !== undefined) this.recordFeedbackUnavailable(latest, feedback, deliveryId, observationId);
				throw new Error("Executor binding changed before feedback delivery was recorded; retrying the same Execution.");
			}
		} catch (error) {
			const current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				!sameRuntimeBinding(current.execution.pi, activeBinding)
			) {
				if (current !== undefined && ["succeeded", "stopped"].includes(current.state))
					this.recordFeedbackSuperseded(current, feedback, deliveryId, observationId);
				else if (current !== undefined) this.recordFeedbackUnavailable(current, feedback, deliveryId, observationId);
				throw error;
			}
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				execution: { ...current.execution, runtimeState: "unreachable" },
				nextAction: "Review feedback delivery failed; Conclave is inspecting the Executor runtime.",
			};
			try {
				this.append({
					meta: {
						actor: "system",
						commandId: `feedback-failure:${execution.executionId}:${current.revision}`,
						expectedWorkRevision: current.revision,
						schemaVersion: 1,
					},
					kind: "delivery",
					workId: current.workId,
					missionId: current.mission?.missionId,
					executionId: execution.executionId,
					payload: {
						observationId,
						deliveryId,
						feedback,
						delivered: false,
						message: error instanceof Error ? error.message : String(error),
					},
					projection: next,
					summary: "Authorized review feedback could not be delivered.",
					effects: [schedulerEffect(current.workId, next.revision, observationId, "runtime-unreachable")],
				});
			} catch {
				// Recovery will reattach the persisted Executor binding.
			}
			throw error;
		} finally {
			finish();
			this.removeActiveExecutorTurn(turnKey, turn);
		}
	}

	// oxlint-disable-next-line complexity
	private recordFeedbackDelivered(
		workId: string,
		observationId: string,
		feedback: readonly string[],
		deliveryId: string,
		executionId: string,
		binding: RuntimeBinding,
	): boolean {
		if (this.hasFeedbackDelivery(workId, observationId, true)) return true;
		const work = this.archive.project(workId);
		if (
			work === undefined ||
			work.execution?.executionId !== executionId ||
			work.execution.state !== "running" ||
			!sameRuntimeBinding(work.execution.pi, binding)
		)
			return false;
		const next: WorkView = { ...work, revision: work.revision + 1 };
		this.append({
			meta: {
				actor: "system",
				commandId: `feedback-delivered:${deliveryId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "delivery",
			workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { observationId, deliveryId, feedback, delivered: true },
			projection: next,
			evidenceRefs: feedback,
			summary: "Authorized provider review feedback was delivered to the Executor.",
		});
		return true;
	}

	private recordFeedbackUnavailable(
		work: WorkView,
		feedback: readonly string[],
		deliveryId: string,
		observationId?: string,
	): void {
		const marker = `feedback-unavailable:${deliveryId}`;
		if (this.heartbeat.has(marker)) return;
		this.heartbeat.set(marker, "recorded");
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			nextAction: "Authorized review feedback remains recorded. Reconcile the next Executor.",
		};
		this.append({
			meta: {
				actor: "system",
				commandId: `feedback-unavailable:${deliveryId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "delivery",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { observationId, deliveryId, feedback, delivered: false, disposition: "retry" },
			projection: next,
			evidenceRefs: feedback,
			summary: "Authorized review feedback was retained for reconciliation.",
		});
	}

	private recordFeedbackSuperseded(
		work: WorkView,
		feedback: readonly string[],
		deliveryId: string,
		observationId?: string,
	): void {
		const marker = `feedback-superseded:${deliveryId}`;
		if (this.heartbeat.has(marker)) return;
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			nextAction: "Provider feedback was superseded by terminal Work; inspect the Archive.",
		};
		this.append({
			meta: {
				actor: "system",
				commandId: `feedback-superseded:${deliveryId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "delivery",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { observationId, deliveryId, feedback, delivered: false, disposition: "superseded" },
			projection: next,
			evidenceRefs: feedback,
			summary: "Authorized provider feedback was superseded by terminal Work.",
		});
		this.heartbeat.set(marker, "recorded");
	}

	// oxlint-disable-next-line complexity
	private async recordOutcome(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		const reviewRequest = work.reviewRequest;
		const mergeEvidence = work.providerOutcome;
		if (
			!isProviderOutcomeSettlementPending(work) ||
			reviewRequest === undefined ||
			reviewRequest.status !== "merged" ||
			mergeEvidence === undefined ||
			mergeEvidence.kind !== "provider-outcome" ||
			mergeEvidence.providerId !== reviewRequest.providerId ||
			mergeEvidence.status !== "merged" ||
			mergeEvidence.repository !== reviewRequest.repository ||
			mergeEvidence.sourceBranch !== reviewRequest.sourceBranch ||
			mergeEvidence.targetBranch !== reviewRequest.targetBranch ||
			mergeEvidence.headCommit !== reviewRequest.headCommit ||
			mergeEvidence.mergeCommit === undefined
		) {
			throw this.error(
				"invalid-state",
				"A Work Outcome requires provider-confirmed merge evidence.",
				false,
				"Poll and inspect the provider outcome first.",
			);
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "succeeded",
			missionState: "succeeded",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "completed", endedAt: new Date().toISOString() },
			budget: releaseExecutionReservation(work.budget, work.execution),
			lastError: undefined,
			nextAction: "Work succeeded.",
		};
		return this.append({
			meta,
			kind: "outcome",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { reviewRequestId: reviewRequest.providerId, mergeEvidence: mergeEvidence.summary },
			projection: next,
			summary: "Provider-confirmed merge accepted as the Work Outcome.",
			effects: lifecycleEffects(work.workId, next.revision, next.execution, undefined, false),
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async failWork(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		if (meta.actor !== "user" && meta.actor !== "conclave") {
			throw this.error(
				"forbidden",
				"Only User or Conclave can fail Work explicitly.",
				false,
				"Use an authorized actor.",
			);
		}
		if (["succeeded", "stopped"].includes(work.state)) {
			throw this.error(
				"invalid-state",
				"Terminal Work cannot be failed again.",
				false,
				"Inspect the existing terminal Outcome.",
			);
		}
		const reason = requiredNonBlank(requiredText(input?.reason, "reason"), "reason");
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "stopped",
			stopReason: "failed",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "failed", endedAt: new Date().toISOString() },
			observer: undefined,
			observerInFlight: false,
			budget: releaseExecutionReservation(work.budget, work.execution),
			nextAction: "Work failed by explicit decision.",
		};
		return this.append({
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

	// oxlint-disable-next-line complexity
	private renameWork(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "user");
		if (work.state === "succeeded") {
			throw this.error(
				"invalid-state",
				"Succeeded Work cannot be renamed.",
				false,
				"Rename an active or failed Work instead.",
			);
		}
		const title = requiredNonBlank(requiredText(input?.title, "title"), "title");
		if (title === work.terms.title) {
			throw this.error(
				"invalid-input",
				"The new Work title matches the current title.",
				false,
				"Choose a different title.",
			);
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			terms: { ...work.terms, title },
		};
		return this.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { change: "title", previousTitle: work.terms.title, title },
			projection: next,
			summary: `Work title renamed to ${title}.`,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private amendBudget(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "user");
		const maxTokens = input?.maxTokens;
		if (maxTokens === undefined || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
			throw this.error(
				"invalid-input",
				"maxTokens must be a positive integer.",
				false,
				"Supply a larger positive Work budget.",
			);
		}
		if (maxTokens < work.budget.reservedTokens + work.budget.consumedTokens) {
			throw this.error(
				"invalid-input",
				"The amended cap cannot be below reserved or consumed tokens.",
				false,
				"Choose a cap that covers current reservations and consumption.",
			);
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			terms: { ...work.terms, maxTokens },
			budget: { ...work.budget, maxTokens },
			nextAction: work.nextAction,
		};
		return this.append({
			meta,
			kind: "work-amended",
			workId: work.workId,
			payload: { previousMaxTokens: work.budget.maxTokens, maxTokens },
			projection: next,
			summary: `Work token cap amended to ${maxTokens}.`,
		}).projection;
	}

	// oxlint-disable-next-line complexity
	private async recoverRuntime(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): Promise<WorkView> {
		this.requireAnyActor(meta, ["user", "conclave"]);
		onRecoveryUpdate?.({ stage: "checking", message: "Checking whether this Work can be recovered." });
		const execution = work.execution;
		if (
			execution === undefined ||
			execution.pi === undefined ||
			(execution.state !== "running" && execution.state !== "awaiting-review")
		) {
			throw this.error(
				"invalid-state",
				"No recoverable Executor runtime is bound to this Work.",
				false,
				"Inspect the current Execution before recovering it.",
			);
		}
		if ((await this.ports.runtime.getState(execution.pi)) !== "unreachable") {
			throw this.error(
				"invalid-state",
				"The Executor runtime is reachable and does not need recovery.",
				false,
				"Refresh the Work and use the available action for its current state.",
			);
		}
		return this.recoverWork(work.workId, meta, onRecoveryUpdate);
	}

	// oxlint-disable-next-line complexity
	private recoverStopped(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): WorkView {
		this.requireActor(meta, "user");
		onRecoveryUpdate?.({ stage: "checking", message: "Preparing the cancelled Work for recovery." });
		if (work.state !== "stopped" || work.stopReason !== "cancelled") {
			throw this.error(
				"invalid-state",
				"Only Work stopped by cancellation can be recovered.",
				false,
				"Inspect the Work state before recovering it.",
			);
		}
		onRecoveryUpdate?.({ stage: "finishing", message: "Returning the recovered Work to admission." });
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "submitted",
			stopReason: undefined,
			lastError: undefined,
			mission: undefined,
			missionState: undefined,
			execution: undefined,
			observer: undefined,
			observerInFlight: false,
			reviewRequest: undefined,
			lastSignal: undefined,
			lastObservation: undefined,
			providerOutcome: undefined,
			budget: { ...work.budget, reservedTokens: 0 },
			nextAction: "Recovered Work is pending Conclave admission.",
		};
		return this.append({
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

	private async cancel(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "user");
		if (["succeeded", "stopped"].includes(work.state)) {
			throw this.error(
				"invalid-state",
				"Terminal Work cannot be cancelled.",
				false,
				"Inspect the terminal Work evidence.",
			);
		}
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "stopped",
			stopReason: "cancelled",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "stopped", endedAt: new Date().toISOString() },
			observer: undefined,
			observerInFlight: false,
			budget: releaseExecutionReservation(work.budget, work.execution),
			nextAction: "Work cancelled by the User.",
		};
		return this.append({
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

	private append(
		input: Readonly<{
			meta: CommandMeta;
			kind: ArchiveAppend["kind"];
			workId: string;
			missionId?: string | undefined;
			executionId?: string | undefined;
			payload: ArchiveAppend["payload"];
			projection: WorkView;
			summary: string;
			evidenceRefs?: readonly string[] | undefined;
			effects?: ArchiveAppend["effects"];
			executionGuard?: ArchiveAppend["executionGuard"];
		}>,
	) {
		try {
			const result = this.archive.append({
				commandId: input.meta.commandId,
				expectedWorkRevision: input.meta.expectedWorkRevision ?? 0,
				kind: input.kind,
				actor: input.meta.actor,
				workId: input.workId,
				missionId: input.missionId,
				executionId: input.executionId,
				payloadVersion: 1,
				summary: input.summary,
				evidenceRefs: input.evidenceRefs,
				payload: input.payload,
				projection: input.projection,
				effects: input.effects,
				executionGuard: input.executionGuard,
			});
			return { projection: result.projection, duplicate: result.duplicate };
		} catch (error) {
			if (error instanceof RevisionConflict) {
				throw this.error(
					"revision-conflict",
					error.message,
					true,
					"Reread the Work and retry with its current revision.",
				);
			}
			throw error;
		}
	}

	// oxlint-disable-next-line complexity
	private normalizeRecordQuery(
		query: RecordQuery | undefined,
		actor: Actor,
		boundWorkId?: string,
		boundExecutionId?: string,
	): RecordQuery {
		if (actor === "user" || actor === "monitor") {
			return query ?? {};
		}
		const workId = query?.workId;
		if (workId === undefined || (boundWorkId !== undefined && boundWorkId !== workId)) {
			throw this.error(
				"forbidden",
				"This role must read its bound Work at a time.",
				false,
				"Supply the bound Work ID.",
			);
		}
		if (actor === "executor" && query?.executionId !== undefined && query.executionId !== boundExecutionId)
			throw this.error(
				"forbidden",
				"This Executor must read its bound Execution at a time.",
				false,
				"Supply the bound Execution ID.",
			);
		return { ...query, workId };
	}

	private requireReadableActor(actor: Actor): void {
		if (!["user", "conclave", "observer", "executor", "monitor"].includes(actor)) {
			throw this.error("forbidden", "This role cannot read Archive records.", false, "Use an authorized role session.");
		}
	}

	private requireActor(meta: CommandMeta, actor: Actor): void {
		if (meta.actor !== actor) {
			throw this.error(
				"forbidden",
				`Only the ${actor} role may perform this action.`,
				false,
				roleActionRemediation(meta.actor, actor),
			);
		}
	}

	private requireAnyActor(meta: CommandMeta, actors: readonly Actor[]): void {
		if (actors.includes(meta.actor)) return;
		throw this.error(
			"forbidden",
			`Only ${actors.join(" or ")} roles may perform this action.`,
			false,
			"Use the role-bound application adapter.",
		);
	}

	private checkRevision(work: WorkView, meta: CommandMeta): void {
		if (meta.expectedWorkRevision !== work.revision) {
			throw this.error(
				"revision-conflict",
				`Work ${work.workId} is at revision ${work.revision}.`,
				true,
				"Reread the Work and retry.",
			);
		}
	}

	private requireExecution(work: WorkView, state?: Execution["state"]): Execution {
		if (work.execution === undefined || (state !== undefined && work.execution.state !== state)) {
			throw this.error(
				"invalid-state",
				"The current Execution does not satisfy the requested state.",
				false,
				"Inspect the current Execution before acting.",
			);
		}
		return work.execution;
	}

	// oxlint-disable-next-line complexity
	private validateModel(role: "conclave" | "observer" | "executor" | "oracle", model: string, thinking: string): void {
		try {
			if (!this.ports.models.listScoped(role).includes(model)) {
				throw new Error(`Model ${model} is not configured for the ${role} role.`);
			}
			const resolved = this.ports.models.resolve(model);
			if (!resolved.supportedThinking.includes(thinking)) {
				throw new Error(`Thinking level ${thinking} is not supported by model ${model}.`);
			}
		} catch (error) {
			throw this.error(
				"external-failure",
				error instanceof Error ? error.message : "The configured model could not be resolved.",
				false,
				"Open /khala, press r, configure a role-scoped model and supported thinking level, then retry admission.",
			);
		}
	}

	private action(
		kind: Action["kind"],
		work: WorkView,
		expectedWorkRevision: number,
		enabled: boolean,
		label: string,
		disabledReason?: string,
	): Action {
		return {
			id: `${kind}:${work.workId}:${expectedWorkRevision}`,
			scope: "work",
			kind,
			label,
			enabled,
			disabledReason,
			expectedWorkRevision,
		};
	}

	private inputEnvelope(summary: string): ErrorEnvelope {
		return {
			code: "invalid-input",
			summary,
			retryable: false,
			remediation: "Correct the action input and retry.",
			evidenceRefs: [],
		};
	}

	private requireRoleBinding(meta: CommandMeta, work: WorkView): void {
		const capability = this.requireCapability(meta);
		if (capability.role !== meta.actor)
			throw this.error(
				"forbidden",
				"The role capability does not match the actor.",
				false,
				"Use the runtime-launched role session.",
			);
		this.requireScopedCapability(meta, capability, work);
	}

	// oxlint-disable-next-line complexity
	private requireScopedCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): void {
		if (meta.actor === "conclave" && (capability.workId !== work.workId || meta.roleNonce !== capability.nonce)) {
			throw this.error(
				"forbidden",
				"The Conclave session is not bound to this Work.",
				false,
				"Use the scheduled Conclave session.",
			);
		}
		if (
			meta.actor === "executor" &&
			(capability.workId !== work.workId ||
				capability.executionId !== work.execution?.executionId ||
				meta.roleNonce !== capability.nonce ||
				capability.nonce !== work.execution?.pi?.capabilityNonce)
		) {
			throw this.error(
				"forbidden",
				"The Executor session is not bound to this Work Execution.",
				false,
				"Use the bound Executor session.",
			);
		}
		if (
			meta.actor === "observer" &&
			(capability.workId !== work.workId ||
				meta.roleNonce !== capability.nonce ||
				capability.nonce !== work.observer?.capabilityNonce)
		) {
			throw this.error(
				"forbidden",
				"The Observer session is not bound to this Work.",
				false,
				"Use the bound Observer session.",
			);
		}
	}

	// oxlint-disable-next-line complexity
	private requireCapability(meta: CommandMeta): RoleCapability {
		const token = meta.roleToken;
		const [encoded, signature] = token?.split(".") ?? [];
		if (encoded === undefined || signature === undefined)
			throw this.error("forbidden", "The role capability is missing.", false, "Use the runtime-launched role session.");
		let parsed: JsonValue;
		try {
			// SAFETY: capability payloads are parsed as JsonValue before domain fields are inspected below.
			parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as JsonValue;
		} catch {
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		}
		if (!isJsonObject(parsed))
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		const role = readCapabilityRole(parsed["role"]);
		if (
			role === undefined ||
			!verify(null, Buffer.from(encoded, "utf8"), this.rolePublicKey, Buffer.from(signature, "base64url"))
		) {
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		}
		const workId = readCapabilityText(parsed["workId"]);
		const executionId = readCapabilityText(parsed["executionId"]);
		const nonce = readCapabilityText(parsed["nonce"]);
		return { role, workId, executionId, nonce };
	}

	private error(
		code: ErrorEnvelope["code"],
		summary: string,
		retryable: boolean,
		remediation: string,
	): ApplicationError {
		return new ApplicationError({ code, summary, retryable, remediation, evidenceRefs: [] });
	}
}

function isTransientConclaveWakeFailure(message: string): boolean {
	return message.includes("Pi child exited") || message.includes("Pi RPC get_state timed out");
}

// oxlint-disable-next-line complexity
function roleActionRemediation(actor: Actor, expected: Actor): string {
	if (actor === "user" && expected === "executor") {
		return "Executor Signals and review requests come from the bound Executor session. Read the Archive or poll the provider instead of recording Executor evidence as the User.";
	}
	if (actor === "user" && expected === "conclave") {
		return "Conclave actions run in the bound Conclave session. Read the Archive and wait for the autonomous Conclave wake.";
	}
	return "Use the role-bound application adapter.";
}

// oxlint-disable-next-line complexity
function conclaveWakeError(
	failure: Error,
	feedbackWake = false,
	runtimeWake = false,
	outcomeWake = false,
): ErrorEnvelope {
	if (failure instanceof ApplicationError) return failure.envelope;
	const message = failure instanceof Error ? failure.message : String(failure);
	if (runtimeWake) {
		return {
			code: "external-failure",
			summary: `Conclave runtime recovery failed: ${message.slice(0, 2_000)}`,
			retryable: true,
			remediation:
				"Inspect Evidence and retry the autonomous runtime inspection. Do not restart the primary Pi session.",
			evidenceRefs: [],
		};
	}
	if (outcomeWake) {
		return {
			code: "external-failure",
			summary: `Conclave outcome settlement failed: ${message.slice(0, 2_000)}`,
			retryable: true,
			remediation:
				"Inspect the Archive, restore the Conclave runtime if needed, and retry provider outcome settlement.",
			evidenceRefs: [],
		};
	}
	if (feedbackWake) {
		return {
			code: "external-failure",
			summary: `Conclave feedback assessment failed: ${message.slice(0, 2_000)}`,
			retryable: true,
			remediation: "Inspect Evidence, restore the Conclave runtime if needed, and retry delivery explicitly.",
			evidenceRefs: [],
		};
	}
	return {
		code: "external-failure",
		summary: `Conclave admission failed: ${message.slice(0, 2000)}`,
		retryable: true,
		remediation:
			"Open /khala, press r, choose a working Conclave model and thinking level, then run khala-recover to retry admission.",
		evidenceRefs: [],
	};
}

// oxlint-disable-next-line complexity
function readCapabilityRole(value: JsonValue | undefined): GovernedRole | undefined {
	if (value === "conclave" || value === "observer" || value === "executor" || value === "oracle") return value;
	return undefined;
}

function readCapabilityText(value: JsonValue | undefined): string | undefined {
	return value === undefined ? undefined : isTextValue(value) ? value : undefined;
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

// oxlint-disable-next-line complexity
function normalizeTerms(input: SubmitWorkInput, defaultWorkTokens: number): WorkTerms {
	const title = assertNonBlank(input.title, "title");
	const objective = assertNonBlank(input.objective, "objective");
	if (input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.some((entry) => entry.trim().length === 0)) {
		throw new Error("acceptanceCriteria must contain at least one nonblank item.");
	}
	const maxTokens = input.maxTokens ?? defaultWorkTokens;
	assertPositiveInteger(maxTokens, "maxTokens");
	return {
		title,
		objective,
		context: input.context?.trim() ?? "",
		scope: input.scope?.trim() || DEFAULT_SCOPE,
		acceptanceCriteria: input.acceptanceCriteria.map((entry) => assertNonBlank(entry, "acceptanceCriteria item")),
		constraints: (input.constraints ?? []).map((entry) => assertNonBlank(entry, "constraints item")),
		validation: (input.validation ?? [DEFAULT_VALIDATION]).map((entry) => assertNonBlank(entry, "validation item")),
		allowedPaths: normalizeAllowedPaths(input.allowedPaths ?? ["."]),
		maxTokens,
	};
}

function mergeTermChanges(terms: WorkTerms, input: ActionInput | undefined, mission: boolean): WorkTerms {
	const changes = requireTermChanges(input);
	const context = changes.context === undefined ? terms.context : changes.context.trim();
	const merged = {
		objective: changedText(terms.objective, changes.objective, "objective"),
		context,
		scope: changedText(terms.scope, changes.scope, "scope"),
		acceptanceCriteria: changedList(terms.acceptanceCriteria, changes.acceptanceCriteria, "acceptanceCriteria"),
		constraints: changedList(terms.constraints, changes.constraints, "constraints"),
		validation: changedList(terms.validation, changes.validation, "validation"),
		allowedPaths: changes.allowedPaths === undefined ? terms.allowedPaths : normalizeAllowedPaths(changes.allowedPaths),
	};
	requireNonEmptyTermList(merged.acceptanceCriteria, "acceptanceCriteria");
	requireNonEmptyTermList(merged.validation, "validation");
	if (mission) validateMissionContext(changes.context, merged.context);
	return { ...terms, ...merged };
}

function requireTermChanges(input: ActionInput | undefined): ActionInput {
	if (input === undefined || !hasTermChange(input)) throw new ActionInputError("At least one Work term is required.");
	return input;
}

function requireNonEmptyTermList(values: readonly string[], key: string): void {
	if (values.length === 0) throw new ActionInputError(`${key} must contain at least one item.`);
}

function validateMissionContext(changedContext: string | undefined, context: string): void {
	if (changedContext !== undefined) requireMissionContext(context);
}

function requireMissionContext(context: string): void {
	if (context.length === 0)
		throw new ActionInputError(
			"Mission context cannot be cleared; create a new Work if it is no longer authoritative.",
		);
}

function hasTermChange(input: ActionInput): boolean {
	return [
		input.objective,
		input.context,
		input.scope,
		input.acceptanceCriteria,
		input.constraints,
		input.validation,
		input.allowedPaths,
	].some((value) => value !== undefined);
}

function changedText(current: string, value: string | undefined, key: string): string {
	return value === undefined ? current : requiredNonBlank(value, key);
}

function changedList(current: readonly string[], value: readonly string[] | undefined, key: string): readonly string[] {
	return value === undefined ? current : readActionTextList(value, key);
}

function normalizeAllowedPaths(paths: readonly string[]): readonly string[] {
	if (paths.length === 0) throw new ActionInputError("allowedPaths must contain at least one path.");
	return [...new Set(paths.map(normalizeAllowedPath))];
}

function hasActiveExecution(work: WorkView): boolean {
	return work.execution !== undefined && !["failed", "stopped"].includes(work.execution.state);
}

function normalizeAllowedPath(path: string): string {
	const value = path
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/");
	if (/^(?:$|\.\.(?:\/|$)|\/)/.test(value))
		throw new ActionInputError(`allowedPaths contains an invalid path: ${path}`);
	return value === "." ? "." : value.replace(/\/$/, "");
}

function readActionTextList(values: readonly string[], key: string): readonly string[] {
	return values.map((entry) => requiredNonBlank(entry, `${key} item`));
}

function readOptionalActionTextList(values: readonly string[] | undefined, key: string): readonly string[] {
	return values === undefined ? [] : readActionTextList(values, key);
}

function missionSpecificity(terms: WorkTerms): MissionSpecificity {
	const missing = defaultTermNames(terms);
	return { status: missing.length === 0 ? "explicit" : "defaults-used", missing };
}

function defaultTermNames(terms: WorkTerms): readonly string[] {
	const missing: string[] = [];
	if (terms.scope === DEFAULT_SCOPE) missing.push("scope");
	if (isDefaultValidation(terms.validation)) missing.push("validation");
	return missing;
}

function isDefaultValidation(validation: readonly string[]): boolean {
	return validation.length === 1 && validation[0] === DEFAULT_VALIDATION;
}

// oxlint-disable-next-line complexity
function rawMissionSpecificity(input: SubmitWorkInput): MissionSpecificity {
	const missing = [
		input.scope?.trim() ? undefined : "scope",
		input.validation !== undefined && input.validation.length > 0 ? undefined : "validation",
	].filter((entry): entry is string => entry !== undefined);
	return { status: missing.length === 0 ? "explicit" : "defaults-used", missing };
}

function isAllowedPath(path: string, allowedPaths: readonly string[]): boolean {
	const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	return allowedPaths.some(
		(allowed) => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`),
	);
}

function executorTurnKey(workId: string, executionId: string): string {
	return `${workId}:${executionId}`;
}

// oxlint-disable-next-line complexity
function sameRuntimeBinding(left: RuntimeBinding | undefined, right: RuntimeBinding | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.sessionId === right.sessionId &&
		left.sessionPath === right.sessionPath &&
		left.processGroupId === right.processGroupId &&
		left.processStartTime === right.processStartTime &&
		left.capabilityNonce === right.capabilityNonce &&
		left.processMarker === right.processMarker
	);
}

function executionDriveKey(workId: string, execution: Execution): string {
	return `${workId}:${execution.executionId}:${runtimeBindingKey(execution.pi)}`;
}

function observerDriveKey(workId: string, binding: RuntimeBinding): string {
	return `${workId}:${runtimeBindingKey(binding)}`;
}

function runtimeBindingKey(binding: RuntimeBinding | undefined): string {
	return JSON.stringify(binding ?? null);
}

// oxlint-disable-next-line complexity
function shouldMonitorProvider(work: WorkView): boolean {
	return (
		work.reviewRequest !== undefined &&
		(work.reviewRequest.status === "draft" || work.reviewRequest.status === "open") &&
		!["succeeded", "stopped"].includes(work.state) &&
		(work.state === "awaiting-review" ||
			work.execution?.state === "running" ||
			work.execution?.state === "awaiting-review")
	);
}

function monitorMeta(work: WorkView, subject: string, bucket: number): CommandMeta {
	return {
		actor: "monitor",
		commandId: `monitor:${subject}:${work.workId}:${bucket}`,
		expectedWorkRevision: work.revision,
		schemaVersion: 1,
	};
}

// oxlint-disable-next-line complexity
function runtimeAction(work: WorkView, runtimeState: RuntimeState): string {
	if (work.execution === undefined || !["running", "awaiting-review"].includes(work.execution.state))
		return work.nextAction;
	if (runtimeState === "unreachable") return "Executor runtime is unreachable. Recover it from Actions.";
	if (work.execution.state !== "running") return work.nextAction;
	if (
		runtimeState === "idle" &&
		["Executor is working.", "Executor is resuming authorized review feedback."].includes(work.nextAction)
	)
		return "Executor is idle; waiting for a Signal.";
	if (runtimeState === "working" && work.nextAction === "Executor is idle; waiting for a Signal.")
		return "Executor is working.";
	return work.nextAction;
}

// oxlint-disable-next-line complexity
function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	return {
		inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
		outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
		cacheHitTokens: (previous?.cacheHitTokens ?? 0) + current.cacheHitTokens,
		cacheMissTokens: (previous?.cacheMissTokens ?? 0) + current.cacheMissTokens,
	};
}

function tokenUsageTotal(usage: TokenUsage): number {
	return usage.inputTokens + usage.outputTokens;
}

function applyUsage(budget: WorkBudget, previous: TokenUsage | undefined, current: TokenUsage | undefined): WorkBudget {
	if (current === undefined) return budget;
	const delta = Math.max(0, tokenUsageTotal(current) - (previous === undefined ? 0 : tokenUsageTotal(previous)));
	const consumed = Math.min(delta, budget.reservedTokens, budget.maxTokens - budget.consumedTokens);
	return {
		...budget,
		reservedTokens: budget.reservedTokens - consumed,
		consumedTokens: budget.consumedTokens + consumed,
	};
}

function releaseExecutionReservation(budget: WorkBudget, execution: Execution | undefined): WorkBudget {
	if (execution === undefined) return budget;
	return { ...budget, reservedTokens: Math.max(0, budget.reservedTokens - execution.tokenAllowance) };
}

// oxlint-disable-next-line complexity
function executionFailure(work: WorkView, executionId: string, error: Error | string): ErrorEnvelope {
	const failure = (error instanceof Error ? error.message : error).trim().slice(0, 2_000);
	const missingTerms = work.mission?.specificity?.missing ?? [];
	return {
		code: "external-failure",
		summary: `Execution ${executionId} failed${failure.length === 0 ? "." : `: ${failure}`}`,
		retryable: true,
		remediation: "Inspect Evidence, then replace the Execution or amend the Mission before retrying.",
		evidenceRefs: [executionId],
		learning: {
			failure: failure.length === 0 ? "The Executor failed without a provider error message." : failure,
			missionSpecificity:
				missingTerms.length === 0
					? "Mission terms were explicit; inspect the runtime failure before changing scope."
					: `Mission relied on default ${missingTerms.join(" and ")}; make those terms explicit before retrying.`,
			nextMissionGuidance:
				"If the failure exposed missing intent, make that constraint explicit before starting a replacement Execution.",
		},
	};
}

function roleSessionPath(projectPath: string, role: "observer", workId: string): string {
	const projectKey = createHash("sha256").update(projectPath).digest("hex").slice(0, 24);
	const suffix = `${role}-${createHash("sha256").update(workId).digest("hex").slice(0, 24)}`;
	return join(tmpdir(), "khala-sessions", projectKey, `khala-${suffix}-session.jsonl`);
}

function schedulerEffect(workId: string, revision: number, observationId?: string, reason?: string) {
	const payload: JsonObject = { workId, observationId, reason };
	return {
		effectId: `conclave-wake:${workId}:${revision}`,
		kind: "conclave-wake",
		payload,
	};
}

function queueSchedulerEffect(workId: string, revision: number) {
	return { effectId: `scheduler-wake:${workId}:${revision}`, kind: "scheduler-wake", payload: { workId } };
}

function executorEffect(workId: string, revision: number) {
	return { effectId: `executor-wake:${workId}:${revision}`, kind: "executor-wake", payload: { workId } };
}

function executorRecoveryEffect(workId: string, revision: number, executionId: string) {
	return {
		effectId: `executor-recovery:${workId}:${executionId}:${revision}`,
		kind: "executor-recovery",
		payload: { workId, executionId },
	};
}

function observerEffect(workId: string, revision: number) {
	return { effectId: `observer-wake:${workId}:${revision}`, kind: "observer-wake", payload: { workId } };
}

function feedbackEffect(
	workId: string,
	revision: number,
	observationId: string | undefined,
	feedback: readonly string[],
) {
	return {
		effectId: `feedback-wake:${workId}:${revision}`,
		kind: "feedback-wake",
		payload: { workId, observationId, feedback },
	};
}

function sandboxCleanupEffect(workId: string, executionId: string, sandbox: Execution["sandbox"]) {
	return {
		effectId: `workspace-cleanup:${workId}:orphan-${executionId}`,
		kind: "workspace-cleanup",
		payload: { workId, path: sandbox.path, baseCommit: sandbox.baseCommit, branch: sandbox.branch },
	};
}

// oxlint-disable-next-line complexity
function cleanupEffect(workId: string, execution: Execution) {
	const bindingIdentity = execution.pi?.processMarker ?? execution.pi?.sessionId ?? "unbound";
	return {
		effectId: `workspace-cleanup:${workId}:${execution.executionId}:${bindingIdentity}`,
		kind: "workspace-cleanup",
		payload: {
			workId,
			path: execution.sandbox.path,
			baseCommit: execution.sandbox.baseCommit,
			branch: execution.sandbox.branch,
			sessionId: execution.pi?.sessionId,
			sessionPath: execution.pi?.sessionPath,
			processGroupId: execution.pi?.processGroupId,
			processStartTime: execution.pi?.processStartTime,
			capabilityNonce: execution.pi?.capabilityNonce,
			processMarker: execution.pi?.processMarker,
		},
	};
}

function executorStopEffect(workId: string, revision: number, execution: Execution) {
	if (execution.pi === undefined) throw new Error("An Executor stop effect requires a runtime binding.");
	return {
		effectId: `executor-stop:${workId}:${execution.executionId}:${revision}`,
		kind: "executor-stop",
		payload: {
			workId,
			executionId: execution.executionId,
			sessionId: execution.pi.sessionId,
			sessionPath: execution.pi.sessionPath,
			processGroupId: execution.pi.processGroupId,
			processStartTime: execution.pi.processStartTime,
			capabilityNonce: execution.pi.capabilityNonce,
			processMarker: execution.pi.processMarker,
		},
	};
}

function observerCleanupEffect(workId: string, binding: RuntimeBinding) {
	return {
		effectId: `observer-cleanup:${workId}:${runtimeBindingKey(binding)}`,
		kind: "observer-cleanup",
		payload: {
			workId,
			sessionId: binding.sessionId,
			sessionPath: binding.sessionPath,
			processGroupId: binding.processGroupId,
			processStartTime: binding.processStartTime,
			capabilityNonce: binding.capabilityNonce,
			processMarker: binding.processMarker,
		},
	};
}

function observerEffects(workId: string, revision: number, binding: RuntimeBinding | undefined) {
	const effects = [schedulerEffect(workId, revision)];
	if (binding !== undefined) effects.push(observerCleanupEffect(workId, binding));
	return effects;
}

// oxlint-disable-next-line complexity
function lifecycleEffects(
	workId: string,
	revision: number,
	execution: Execution | undefined,
	observer?: RuntimeBinding,
	wakeConclave = true,
) {
	const effects: Array<
		| ReturnType<typeof schedulerEffect>
		| ReturnType<typeof queueSchedulerEffect>
		| ReturnType<typeof cleanupEffect>
		| ReturnType<typeof executorStopEffect>
		| ReturnType<typeof observerCleanupEffect>
	> = [];
	if (wakeConclave) effects.push(schedulerEffect(workId, revision));
	if (
		execution !== undefined &&
		["awaiting-review", "blocked", "completed", "failed", "stopped"].includes(execution.state)
	)
		effects.push(queueSchedulerEffect(workId, revision));
	if (execution?.state === "awaiting-review" && execution.pi !== undefined)
		effects.push(executorStopEffect(workId, revision, execution));
	if (execution !== undefined && ["completed", "failed", "stopped"].includes(execution.state))
		effects.push(cleanupEffect(workId, execution));
	if (observer !== undefined) effects.push(observerCleanupEffect(workId, observer));
	return effects;
}

function readEffectWorkId(payload: JsonObject): string {
	const value = payload["workId"];
	if (value === undefined || value !== String(value) || value.trim().length === 0) {
		throw new Error("Conclave wake effect is missing a Work ID.");
	}
	return String(value);
}

function readEffectExecutionId(payload: JsonObject): string {
	const value = payload["executionId"];
	if (value === undefined || value !== String(value) || value.trim().length === 0) {
		throw new Error("Executor recovery effect is missing an Execution ID.");
	}
	return String(value);
}

function readEffectFeedback(payload: JsonObject): readonly string[] {
	const value = payload["feedback"];
	if (!Array.isArray(value)) throw new Error("Feedback effect is missing its feedback list.");
	return value.map((entry) => {
		if (!isTextValue(entry)) throw new Error("Feedback effect contains non-text evidence.");
		return entry;
	});
}

function readCleanupSandbox(payload: JsonObject): Execution["sandbox"] {
	return {
		path: readEffectText(payload, "path"),
		baseCommit: readEffectText(payload, "baseCommit"),
		branch: readEffectText(payload, "branch"),
	};
}

// oxlint-disable-next-line complexity
function readEffectBinding(payload: JsonObject): RuntimeBinding {
	const processGroupId = payload["processGroupId"];
	const processStartTime = payload["processStartTime"];
	const processMarker = payload["processMarker"];
	return {
		sessionId: readEffectText(payload, "sessionId"),
		sessionPath: readEffectText(payload, "sessionPath"),
		processGroupId: processGroupId === undefined ? undefined : readEffectInteger(processGroupId, "processGroupId"),
		processStartTime:
			processStartTime === undefined ? undefined : readEffectTextValue(processStartTime, "processStartTime"),
		capabilityNonce:
			payload["capabilityNonce"] === undefined
				? undefined
				: readEffectTextValue(payload["capabilityNonce"], "capabilityNonce"),
		processMarker: processMarker === undefined ? undefined : readEffectTextValue(processMarker, "processMarker"),
	};
}

function readOptionalEffectBinding(payload: JsonObject): RuntimeBinding | undefined {
	if (payload["sessionId"] === undefined && payload["sessionPath"] === undefined) return;
	return readEffectBinding(payload);
}

function readEffectText(payload: JsonObject, key: string): string {
	const value = payload[key];
	if (!isTextValue(value) || value.trim().length === 0) throw new Error(`Cleanup effect is missing ${key}.`);
	return value;
}

function readOptionalEffectText(payload: JsonObject, key: string): string | undefined {
	const value = payload[key];
	return value === undefined ? undefined : readEffectTextValue(value, key);
}

function readEffectInteger(value: JsonValue, key: string): number {
	if (value !== Number(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
		throw new Error(`Cleanup effect ${key} is invalid.`);
	return Number(value);
}

function readEffectTextValue(value: JsonValue, key: string): string {
	if (!isTextValue(value) || value.trim().length === 0) throw new Error(`Cleanup effect ${key} is invalid.`);
	return value;
}

function requiredText(value: string | undefined, key: string): string {
	if (value === undefined) throw new ActionInputError(`Action input ${key} must be text.`);
	return value;
}

function requiredNonBlank(value: string, key: string): string {
	try {
		return assertNonBlank(value, key);
	} catch (error) {
		throw new ActionInputError(error instanceof Error ? error.message : `${key} must not be blank.`);
	}
}

// oxlint-disable-next-line complexity
function readTextList(input: ActionInput | undefined, key: "evidence" | "feedback"): readonly string[] {
	const value = key === "evidence" ? input?.evidence : input?.feedback;
	if (value === undefined) throw new ActionInputError(`Action input ${key} must be a list of text.`);
	return value.map((entry) => requiredNonBlank(entry, `${key} item`));
}

function boundedFeedback(feedback: readonly string[]): readonly string[] {
	return feedback
		.map((item) => item.trim().slice(0, 2_000))
		.filter((item) => item.length > 0)
		.slice(0, 20);
}

// oxlint-disable-next-line complexity
function readSignalKind(input: ActionInput | undefined): Signal["kind"] {
	const value = requiredText(input?.kind, "kind");
	if (value !== "progress" && value !== "blocked" && value !== "ready") {
		throw new ActionInputError(`Signal kind ${value} is invalid.`);
	}
	return value;
}

// oxlint-disable-next-line complexity
function readDecision(input: ActionInput | undefined): "continue" | "replace" | "handoff" | "reject" {
	const value = requiredText(input?.decision, "decision");
	if (value !== "continue" && value !== "replace" && value !== "handoff" && value !== "reject") {
		throw new ActionInputError(`Verdict decision ${value} is invalid.`);
	}
	return value;
}

// oxlint-disable-next-line complexity
function readReviewStatus(input: ActionInput | undefined): "changes-requested" | "merged" | "closed" {
	const value = requiredText(input?.status, "status");
	if (value !== "changes-requested" && value !== "merged" && value !== "closed") {
		throw new ActionInputError(`Review status ${value} is invalid.`);
	}
	return value;
}

function oraclePayload(
	result: OracleResult,
	promptIdentity: Readonly<{ packageVersion: string; promptSha256: string }>,
): JsonObject {
	return {
		promptIdentity,
		verdict: result.verdict,
		findings: result.findings.map((finding) => ({
			severity: finding.severity,
			summary: finding.summary,
			evidence: finding.evidence,
		})),
		validationGaps: [...result.validationGaps],
		durationMs: result.durationMs,
		output: result.output.slice(0, 16_000),
	};
}

function providerObservationEvidence(work: WorkView, observation: ProviderObservation): readonly string[] {
	const reviewUrl = work.reviewRequest?.url;
	return [reviewUrl, observation.observationId].filter((value): value is string => value !== undefined);
}

function isProviderMonitorError(error: ErrorEnvelope): boolean {
	return error.source === "provider-monitor" || error.summary.startsWith("Provider monitor failed:");
}

function monitorFailureMarker(subject: string, workId: string): string {
	return `monitor-failure:${subject}:${workId}`;
}

// oxlint-disable-next-line complexity
function providerPollRecoveryAction(work: WorkView, observation: ProviderObservation): string {
	if (observation.kind === "review-comment" && observation.actionable !== false)
		return "Conclave is assessing provider feedback.";
	if (work.execution?.state === "running") return "Khala is continuing the Work automatically.";
	return work.nextAction;
}

function observationKey(workId: string, observation: ProviderObservation): string {
	return `${workId}:${observation.kind}:${observation.providerId}:${observation.observationId}`;
}

function providerOutcomeWakeMarker(workId: string, observationId: string): string {
	return `provider-outcome-wake:${workId}:${observationId}`;
}

function observationFingerprint(observation: ProviderObservation): string {
	return JSON.stringify({
		observationId: observation.observationId,
		kind: observation.kind,
		providerId: observation.providerId,
		status: observation.status,
		summary: observation.summary,
		repository: observation.repository,
		sourceBranch: observation.sourceBranch,
		targetBranch: observation.targetBranch,
		headCommit: observation.headCommit,
		mergeCommit: observation.mergeCommit,
		feedback: observation.feedback,
		author: observation.author,
		authorAssociation: observation.authorAssociation,
		reviewState: observation.reviewState,
		actionable: observation.actionable,
	});
}

function sameObservation(left: ProviderObservation, right: ProviderObservation): boolean {
	return observationFingerprint(left) === observationFingerprint(right);
}

function isCurrentSignal(work: WorkView): boolean {
	return work.execution !== undefined && work.lastSignal?.executionId === work.execution.executionId;
}

function isCurrentReadySignal(work: WorkView): boolean {
	return isCurrentSignal(work) && work.lastSignal?.kind === "ready";
}

function isOpenReview(reviewRequest: WorkView["reviewRequest"]): boolean {
	return reviewRequest?.status === "draft" || reviewRequest?.status === "open";
}

function isMergedReview(work: WorkView): boolean {
	return work.reviewRequest?.status === "merged";
}

// oxlint-disable-next-line complexity
function isCurrentProviderOutcome(work: WorkView): boolean {
	return (
		work.reviewRequest !== undefined &&
		work.providerOutcome?.kind === "provider-outcome" &&
		work.providerOutcome.status === "merged" &&
		work.providerOutcome.providerId === work.reviewRequest.providerId &&
		work.providerOutcome.repository === work.reviewRequest.repository &&
		work.providerOutcome.sourceBranch === work.reviewRequest.sourceBranch &&
		work.providerOutcome.targetBranch === work.reviewRequest.targetBranch &&
		work.providerOutcome.headCommit === work.reviewRequest.headCommit &&
		work.providerOutcome.mergeCommit !== undefined
	);
}

function isProviderOutcomeSettlementPending(work: WorkView): boolean {
	return (
		(work.state === "active" || work.state === "awaiting-review") &&
		isMergedReview(work) &&
		isCurrentProviderOutcome(work)
	);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function resultText<T>(result: ServiceResult<T>): string {
	return "error" in result ? `${result.error.code}: ${result.error.summary}` : "The command was applied.";
}
