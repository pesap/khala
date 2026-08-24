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
	type JsonObject,
	type JsonValue,
	type Mission,
	type MissionState,
	type Page,
	type ProviderObservation,
	type RecordQuery,
	type RecordView,
	type RecoveryUpdate,
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
	rolePublicKey: string;
}>;

type GovernedRole = "conclave" | "observer" | "executor" | "oracle";
type RoleCapability = Readonly<{
	role: Actor;
	workId?: string | undefined;
	executionId?: string | undefined;
	nonce?: string | undefined;
}>;
const providerPollAuthority = Symbol("provider-poll-authority");

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
	private readonly drivingObservers = new Set<string>();
	private readonly backgroundOperations = new Set<Promise<void>>();
	private closing = false;
	private readonly archive: ArchivePort;
	private readonly ports: ServicePorts;
	private readonly options: ServiceOptions;
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
	}

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
		return projects.map((work) => ({
			workId: work.workId,
			title: work.terms.title,
			state: work.state,
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

	async inspectRuntime(workId: string): Promise<WorkView> {
		const work = this.inspectWork(workId);
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

	availableActions(workId: string, actor: Actor, revision?: number, runtimeState?: RuntimeState): readonly Action[] {
		const work = this.inspectWork(workId);
		const expected = revision ?? work.revision;
		const actions: Action[] = [];
		const runtimeUnavailable =
			work.execution !== undefined &&
			(work.execution.state === "running" || work.execution.state === "awaiting-review") &&
			(runtimeState ?? work.execution.runtimeState) === "unreachable";
		if (actor === "user") {
			actions.push(
				this.action(
					"recover",
					work,
					expected,
					work.state === "cancelled" || runtimeUnavailable,
					"Recover Work",
					work.state === "cancelled" || runtimeUnavailable
						? undefined
						: "Only cancelled Work or an unreachable runtime can be recovered.",
				),
			);
			actions.push(
				this.action(
					"cancel",
					work,
					expected,
					work.state !== "succeeded" && work.state !== "failed" && work.state !== "cancelled",
					"Cancel Work",
				),
			);
			actions.push(
				this.action(
					"fail-work",
					work,
					expected,
					!["succeeded", "failed", "cancelled"].includes(work.state),
					"Fail Work",
					"Terminal Work cannot be failed again.",
				),
			);
			actions.push(
				this.action(
					"amend-budget",
					work,
					expected,
					!["succeeded", "failed", "cancelled"].includes(work.state),
					"Amend Work budget",
					"Terminal Work cannot be amended.",
				),
			);
			actions.push(
				this.action(
					"record-review",
					work,
					expected,
					work.state === "awaiting-review",
					"Record provider review",
					work.state === "awaiting-review" ? undefined : "Work is not awaiting review.",
				),
			);
		}
		if (actor === "conclave") {
			actions.push(
				this.action("admit", work, expected, work.state === "submitted" || work.state === "needs-input", "Admit Work"),
			);
			actions.push(
				this.action(
					"fail-work",
					work,
					expected,
					!["succeeded", "failed", "cancelled"].includes(work.state),
					"Fail Work",
					"Terminal Work cannot be failed again.",
				),
			);
			actions.push(
				this.action(
					"launch-observer",
					work,
					expected,
					(work.state === "submitted" || work.state === "needs-input") &&
						work.terms.context.length === 0 &&
						work.observerInFlight !== true,
					"Gather missing repository context",
					work.terms.context.length === 0 && work.observerInFlight !== true
						? undefined
						: "Work already contains context or an Observer is running.",
				),
			);
			actions.push(
				this.action(
					"start-execution",
					work,
					expected,
					(work.missionState === "admitted" || work.missionState === "active") &&
						((work.state === "queued" && work.mission !== undefined && work.execution === undefined) ||
							(work.state === "active" &&
								work.mission !== undefined &&
								work.execution !== undefined &&
								["failed", "blocked", "stopped"].includes(work.execution.state))),
					"Start Execution",
					work.missionState !== "admitted" && work.missionState !== "active"
						? "The Mission is no longer active."
						: work.state === "queued" ||
								work.execution?.state === "failed" ||
								work.execution?.state === "blocked" ||
								work.execution?.state === "stopped"
							? undefined
							: "Work is not ready for an Execution.",
				),
			);
			actions.push(
				this.action(
					"verdict",
					work,
					expected,
					isCurrentSignal(work) && (work.execution?.state === "running" || work.execution?.state === "blocked"),
					"Issue Verdict",
					isCurrentSignal(work)
						? "The current Execution is not awaiting a Verdict."
						: "No current Signal is available.",
				),
			);
			actions.push(
				this.action(
					"run-oracle",
					work,
					expected,
					isCurrentReadySignal(work) && work.execution?.state === "running" && isOpenReview(work.reviewRequest),
					"Run Oracle review",
					isCurrentReadySignal(work) && isOpenReview(work.reviewRequest)
						? "The current Execution is not running."
						: "Oracle review is available after a current ready Signal and open review request.",
				),
			);
			actions.push(
				this.action(
					"record-outcome",
					work,
					expected,
					isMergedReview(work) && isCurrentProviderOutcome(work),
					"Record Work Outcome",
					"Provider-confirmed merge evidence is required.",
				),
			);
		}
		if (actor === "executor") {
			actions.push(
				this.action(
					"record-signal",
					work,
					expected,
					work.execution?.state === "running",
					"Record Signal",
					"The current Execution is not running.",
				),
			);
			actions.push(
				this.action(
					"create-review-request",
					work,
					expected,
					work.execution?.state === "running" && work.reviewRequest === undefined,
					"Create draft review request",
					"A running Execution without a review request is required.",
				),
			);
		}
		return actions;
	}

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

	private async wakeConclave(workId: string, commandId: string): Promise<void> {
		const work = this.inspectWork(workId);
		this.validateModel("conclave", this.options.conclaveModel, this.options.conclaveThinking);
		const binding = await this.ports.runtime.ensureSession({
			cwd: this.options.projectPath,
			model: this.options.conclaveModel,
			thinking: this.options.conclaveThinking,
			role: "conclave",
			promptIdentity: this.options.conclavePromptIdentity,
			bindingScope: { workId },
			tools: ["khala_read_archive", "khala_perform_action", "khala_run_oracle"],
			sessionPath: roleSessionPath(this.options.projectPath, "conclave", work.workId),
		});
		try {
			await this.ports.runtime.send(
				binding,
				`Process queued Work ${work.workId}. Read the Archive first. Admit it if its Mission terms are complete, then start its Execution when budget permits. Never treat this message as authority.`,
			);
			this.heartbeat.set(commandId, `Conclave wake sent for Work ${work.workId}.`);
		} finally {
			await this.ports.runtime.requestStop(binding).catch(() => undefined);
		}
	}

	async processPendingEffects(): Promise<void> {
		if (this.closing) return;
		const owner = `khala-worker:${randomUUID()}`;
		for (;;) {
			const effects = this.archive.pendingEffects(owner);
			if (effects.length === 0) return;
			let unsupportedEffect = false;
			for (const effect of effects) {
				if (
					effect.kind !== "conclave-wake" &&
					effect.kind !== "executor-wake" &&
					effect.kind !== "executor-stop" &&
					effect.kind !== "observer-wake" &&
					effect.kind !== "feedback-wake" &&
					effect.kind !== "workspace-cleanup" &&
					effect.kind !== "observer-cleanup"
				) {
					this.archive.releaseEffect(effect.effectId, owner);
					unsupportedEffect = true;
					continue;
				}
				let workId: string | undefined;
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
					const work = this.inspectWork(workId);
					if (effect.kind === "conclave-wake") {
						await this.wakeConclave(workId, `outbox:${effect.effectId}:${work.revision}`);
					} else if (effect.kind === "workspace-cleanup") {
						const binding = readOptionalEffectBinding(effect.payload);
						if (binding !== undefined) await this.ports.runtime.requestStop(binding);
						await this.ports.workspace.removeSandbox(readCleanupSandbox(effect.payload));
					} else if (effect.kind === "observer-cleanup" || effect.kind === "executor-stop") {
						await this.ports.runtime.requestStop(readEffectBinding(effect.payload));
					} else if (effect.kind === "feedback-wake") {
						const feedback = readEffectFeedback(effect.payload);
						if (work.execution?.state === "running") {
							await this.resumeExecutor(work, feedback, effect.effectId);
						} else if (!["succeeded", "failed", "cancelled"].includes(work.state)) {
							this.recordFeedbackUnavailable(work, feedback, effect.effectId);
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
					if (leaseLost || !this.archive.completeEffect(effect.effectId, owner))
						throw new Error(`Archive lease was lost for effect ${effect.effectId}.`);
					clearInterval(lease);
				} catch (error) {
					clearInterval(lease);
					this.archive.releaseEffect(effect.effectId, owner);
					if (
						effect.kind === "executor-wake" &&
						workId !== undefined &&
						this.archive.project(workId)?.execution?.state !== "queued"
					)
						queueMicrotask(() => void this.processPendingEffects());
					if (effect.kind === "workspace-cleanup") return;
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
							this.recordWakeFailure(workId, error instanceof Error ? error.message : String(error), {
								actor: "conclave",
								commandId: `outbox-failure:${effect.effectId}:${current.revision}`,
								expectedWorkRevision: current.revision,
								schemaVersion: 1,
							});
						} catch {
							// Preserve the pending effect when its Work cannot be reconciled.
						}
					}
					return;
				}
			}
			if (unsupportedEffect) return;
		}
	}

	async pollProvider(workId: string, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "user");
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
		const outcome = await this.ports.codeHost.inspectOutcome(work.reviewRequest);
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
		return work;
	}

	async recoverWork(
		workId: string,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): Promise<WorkView> {
		this.requireActor(meta, "user");
		onRecoveryUpdate?.({ stage: "checking", message: "Checking the current Work state." });
		const work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		if (["succeeded", "failed", "cancelled"].includes(work.state)) return work;
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
				const rebound = await this.ports.runtime.ensureSession({
					cwd: this.options.projectPath,
					model: this.options.observerModel,
					thinking: this.options.observerThinking,
					role: "observer",
					promptIdentity: this.options.observerPromptIdentity,
					bindingScope: { workId },
					tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
					sessionPath: work.observer.sessionPath,
				});
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
		if (work.mission === undefined || work.execution === undefined) return work;
		const execution = work.execution;
		if (execution.state === "queued") {
			await this.processPendingEffects();
			return this.inspectWork(workId);
		}
		if (execution.pi === undefined || !["running", "awaiting-review"].includes(execution.state)) return work;
		onRecoveryUpdate?.({ stage: "checking", message: "Checking the Work's Executor connection." });
		const executorState = await this.ports.runtime.getState(execution.pi);
		if (executorState === "working") return this.recordExecutorRuntimeState(work, "working");
		if (executorState === "idle") {
			if (execution.state === "running") this.runInBackground(this.driveExecutor(work));
			return work;
		}
		if (executorState !== "unreachable") return work;
		onRecoveryUpdate?.({ stage: "stopping", message: "Closing the unavailable Work attempt safely." });
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
				bindingScope: { workId, executionId: execution.executionId },
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "khala_read_archive", "khala_record_signal"],
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
				workId,
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
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				execution: failed,
				budget: terminalBudget(work.budget, "failed"),
				nextAction: "Execution runtime unavailable; replace it explicitly.",
			};
			return this.append({
				meta,
				kind: "error",
				workId,
				missionId: work.mission.missionId,
				executionId: execution.executionId,
				payload: { message: error instanceof Error ? error.message : "Pi runtime reconciliation failed." },
				projection: next,
				summary: `Execution ${execution.executionId} runtime could not be reconciled.`,
				effects: lifecycleEffects(workId, next.revision, failed),
			}).projection;
		}
	}

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
			return work;
		}
		const nextObservation: ProviderObservation = {
			...observation,
			changed: true,
			observedAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			lastObservation: nextObservation,
			providerOutcome: observation.kind === "provider-outcome" ? nextObservation : work.providerOutcome,
			nextAction: work.nextAction,
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
			effects: observation.kind === "provider-outcome" ? [schedulerEffect(workId, next.revision)] : undefined,
		});
		this.heartbeat.set(key, fingerprint);
		return result.projection;
	}

	private recordWakeFailure(workId: string, message: string, meta: CommandMeta): WorkView {
		const work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			nextAction: "Conclave wake failed; inspect and retry.",
		};
		return this.append({
			meta,
			kind: "error",
			workId,
			payload: { kind: "conclave-wake", message: message.slice(0, 2000) },
			projection: next,
			summary: "Conclave wake failed without changing Work admission state.",
		}).projection;
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		await this.ports.runtime.close();
		await Promise.allSettled(this.backgroundOperations);
		this.archive.close();
	}

	private persistedObservationFingerprint(work: WorkView, observation: ProviderObservation): string | undefined {
		const last = work.lastObservation;
		if (last?.kind === observation.kind && last.providerId === observation.providerId) {
			return sameObservation(last, observation) ? observationFingerprint(last) : undefined;
		}
		const previous = this.archive.findLatestObservation(work.workId, observation.kind, observation.providerId);
		return previous === undefined ? undefined : observationFingerprint(previous);
	}

	private async performOrThrow(command: ActionCommand): Promise<WorkView> {
		const work = this.inspectWork(command.workId);
		this.checkRevision(work, command.meta);
		if (command.meta.actor !== "user") {
			this.requireRoleBinding(command.meta, work);
		}
		switch (command.action) {
			case "admit":
				return this.admit(work, command.meta);
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
			case "record-review":
				return this.recordReview(work, command.meta, command.input);
			case "record-outcome":
				return this.recordOutcome(work, command.meta);
			case "cancel":
				return this.cancel(work, command.meta);
			case "recover":
				return work.state === "cancelled"
					? this.recoverCancelled(work, command.meta, command.onRecoveryUpdate)
					: this.recoverRuntime(work, command.meta, command.onRecoveryUpdate);
			case "amend-budget":
				return this.amendBudget(work, command.meta, command.input);
			case "fail-work":
				return this.failWork(work, command.meta, command.input);
		}
	}

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
		const binding = await this.ports.runtime.ensureSession({
			cwd: this.options.projectPath,
			model: this.options.observerModel,
			thinking: this.options.observerThinking,
			role: "observer",
			promptIdentity: this.options.observerPromptIdentity,
			bindingScope: { workId: work.workId },
			tools: ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"],
			sessionPath: roleSessionPath(this.options.projectPath, "observer", work.workId),
		});
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

	private async driveObserver(work: WorkView, binding: RuntimeBinding): Promise<void> {
		if (this.drivingObservers.has(work.workId)) return;
		this.drivingObservers.add(work.workId);
		try {
			await this.ports.runtime.send(
				binding,
				`Inspect Work ${work.workId} read-only. Record exactly one bounded assessment with concrete repository evidence using Archive revision ${work.revision}, then stop.`,
			);
			const current = this.archive.project(work.workId);
			if (current?.observerInFlight === true && current.observer?.sessionId === binding.sessionId) {
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
			if (current?.observerInFlight !== true) return;
			const binding = current.observer;
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
			this.drivingObservers.delete(work.workId);
		}
	}

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
		if (work.state !== "submitted" && work.state !== "needs-input") {
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
			mandateRevision: 1,
			createdAt: new Date().toISOString(),
		};
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "queued",
			mission,
			missionState: "admitted",
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
		const availableBudget = work.execution?.state === "blocked" ? terminalBudget(work.budget, "blocked") : work.budget;
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
				bindingScope: { workId: work.workId, executionId: execution.executionId },
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "khala_read_archive", "khala_record_signal"],
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
			const failed: Execution = { ...execution, state: "failed", endedAt: new Date().toISOString() };
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				budget: terminalBudget(work.budget, "failed"),
				execution: failed,
				nextAction: "Execution failed; Conclave may replace it.",
			};
			this.append({
				meta: { ...meta, commandId: `${meta.commandId}:failed`, expectedWorkRevision: work.revision },
				kind: "error",
				workId: work.workId,
				missionId: work.mission?.missionId,
				executionId: execution.executionId,
				payload: { message: error instanceof Error ? error.message : String(error) },
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

	private async driveExecutor(work: WorkView): Promise<void> {
		const execution = work.execution;
		if (execution?.pi === undefined) return;
		const key = executionDriveKey(work.workId, execution);
		if (this.drivingExecutions.has(key)) return;
		let finish: () => void = () => undefined;
		const turn = new Promise<void>((resolve) => {
			finish = resolve;
		});
		this.drivingExecutions.set(key, turn);
		try {
			let current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				current.execution.pi?.sessionId !== execution.pi.sessionId
			)
				return;
			current = this.recordExecutorRuntimeState(current, "working");
			const binding = current.execution?.pi;
			if (binding === undefined) return;
			const result = await this.ports.runtime.send(
				binding,
				`Work ${current.workId}, Execution ${execution.executionId} is bound. Read the Archive, inspect the sandbox, implement the Mission, validate it, publish the draft review request, and send evidence-bearing Signals. The current Work revision is ${current.revision}.`,
			);
			this.recordExecutorTurn(current, result);
			queueMicrotask(() => void this.processPendingEffects());
		} catch (error) {
			await this.ports.runtime.requestStop(execution.pi).catch(() => undefined);
			const current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				current.execution.pi?.sessionId !== execution.pi.sessionId
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
				budget: terminalBudget(current.budget, "failed"),
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
					payload: { message: error instanceof Error ? error.message : String(error) },
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
		}
	}

	private recordExecutorRuntimeState(work: WorkView, runtimeState: "working" | "idle"): WorkView {
		const execution = work.execution;
		if (execution === undefined || execution.runtimeState === runtimeState) return work;
		const nextExecution: Execution = { ...execution, runtimeState };
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			execution: nextExecution,
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
		}).projection;
	}

	private recordExecutorTurn(work: WorkView, turn: RuntimeTurn): WorkView {
		const current = this.archive.project(work.workId);
		const execution = current?.execution;
		if (
			current === undefined ||
			execution === undefined ||
			execution.executionId !== work.execution?.executionId ||
			execution.pi?.sessionId !== work.execution?.pi?.sessionId
		)
			return work;
		const usage = turn.usage === undefined ? execution.usage : addTokenUsage(execution.usage, turn.usage);
		const newSignal = current.lastSignal?.signalId !== work.lastSignal?.signalId;
		const nextExecution: Execution =
			usage === undefined ? { ...execution, runtimeState: "idle" } : { ...execution, runtimeState: "idle", usage };
		const next: WorkView = {
			...current,
			revision: current.revision + 1,
			execution: nextExecution,
			nextAction:
				execution.state === "running" && !newSignal ? "Executor is idle; waiting for a Signal." : current.nextAction,
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
			summary: `Execution ${execution.executionId} turn completed; runtime is idle.`,
		}).projection;
	}

	private async recordSignal(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		this.requireActor(meta, "executor");
		const execution = this.requireExecution(work, "running");
		const kind = readSignalKind(input);
		const summary = requiredNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		if (kind === "ready") {
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
			execution: kind === "blocked" ? { ...execution, state: "blocked" } : execution,
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
			effects: kind === "blocked" || kind === "ready" ? [schedulerEffect(work.workId, next.revision)] : undefined,
		}).projection;
	}

	private async createReviewRequest(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "executor");
		const execution = this.requireExecution(work, "running");
		if (work.mission === undefined) {
			throw this.error(
				"invalid-state",
				"A Mission is required before review publication.",
				false,
				"Ask the Conclave to admit Work.",
			);
		}
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
			payload: oraclePayload(result),
			projection: next,
			summary: `Oracle advisory result: ${result.verdict}.`,
		}).projection;
	}

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
		if (signal === undefined || signal.executionId !== execution.executionId || signal.signalId !== signalId) {
			throw this.error(
				"invalid-state",
				"The Verdict must reference the current Signal.",
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
			nextExecution = { ...execution, state: "running" };
			nextState = "active";
			nextAction = "Executor continues.";
		} else if (decision === "handoff") {
			if (signal.kind !== "ready" || !isOpenReview(work.reviewRequest) || execution.state !== "running") {
				throw this.error(
					"invalid-state",
					"Handoff requires a ready Signal and review request.",
					false,
					"Create review evidence before handoff.",
				);
			}
			nextExecution = { ...execution, state: "awaiting-review" };
			nextState = "awaiting-review";
			nextMissionState = "awaiting-review";
			nextAction = "Awaiting User review.";
		} else if (decision === "reject") {
			nextExecution = { ...execution, state: "failed", endedAt: new Date().toISOString() };
			nextMissionState = "rejected";
			nextState = "active";
			nextAction = "Mission rejected; Conclave decision is required for Work closure.";
		} else {
			nextExecution = { ...execution, state: "stopped", endedAt: new Date().toISOString() };
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
			budget: terminalBudget(work.budget, nextExecution.state),
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
					? [feedbackEffect(work.workId, next.revision, feedback)]
					: [
							schedulerEffect(work.workId, next.revision),
							...(work.execution?.pi === undefined
								? []
								: [executorStopEffect(work.workId, next.revision, work.execution)]),
						],
		});
		return result.projection;
	}

	private async resumeExecutor(work: WorkView, feedback: readonly string[], deliveryId: string): Promise<void> {
		const execution = work.execution;
		if (execution?.pi === undefined) return;
		const active = this.drivingExecutions.get(executionDriveKey(work.workId, execution));
		if (active !== undefined) {
			await active;
			const latest = this.archive.project(work.workId);
			if (latest?.execution?.state === "running") return this.resumeExecutor(latest, feedback, deliveryId);
			if (latest !== undefined && !["succeeded", "failed", "cancelled"].includes(latest.state))
				this.recordFeedbackUnavailable(latest, feedback, deliveryId);
			return;
		}
		try {
			let current = work;
			let binding = execution.pi;
			if ((await this.ports.runtime.getState(binding)) === "unreachable") {
				await this.ports.runtime.requestStop(binding).catch(() => undefined);
				const rebound = await this.ports.runtime.ensureSession({
					cwd: execution.sandbox.path,
					model: execution.model,
					thinking: execution.thinking,
					role: "executor",
					promptIdentity: execution.promptIdentity,
					bindingScope: { workId: work.workId, executionId: execution.executionId },
					tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "khala_read_archive", "khala_record_signal"],
					sessionPath: execution.pi.sessionPath,
				});
				try {
					const latest = this.inspectWork(work.workId);
					if (latest.execution?.executionId !== execution.executionId || latest.execution.state !== "running") {
						await this.ports.runtime.requestStop(rebound).catch(() => undefined);
						return;
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
			current = this.recordExecutorRuntimeState(current, "working");
			const result = await this.ports.runtime.send(
				binding,
				`Review feedback delivery ${deliveryId} for Work ${current.workId} is authorized. Read the Archive and address only feedback that fits the Mission. If this delivery ID is already recorded in the Archive, do not repeat the change. Feedback:\n${feedback.map((item) => `- ${item}`).join("\n")}`,
			);
			this.recordExecutorTurn(current, result);
		} catch (error) {
			const current = this.archive.project(work.workId);
			if (
				current?.execution?.executionId !== execution.executionId ||
				current.execution.state !== "running" ||
				current.execution.pi?.sessionId !== execution.pi.sessionId
			)
				return;
			const next: WorkView = {
				...current,
				revision: current.revision + 1,
				execution: { ...current.execution, state: "blocked" },
				nextAction: "Review feedback delivery failed; reconcile the Executor runtime.",
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
					payload: { message: error instanceof Error ? error.message : String(error) },
					projection: next,
					summary: "Authorized review feedback could not be delivered.",
				});
			} catch {
				// Recovery will reattach the persisted Executor binding.
			}
		}
	}

	private recordFeedbackUnavailable(work: WorkView, feedback: readonly string[], deliveryId: string): void {
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			nextAction: "Authorized review feedback remains recorded; reconcile the next Executor.",
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
			payload: { deliveryId, feedback, delivered: false },
			projection: next,
			evidenceRefs: feedback,
			summary: "Authorized review feedback was retained for reconciliation.",
		});
	}

	private async recordOutcome(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		const reviewRequest = work.reviewRequest;
		const mergeEvidence = work.providerOutcome;
		if (
			work.state !== "awaiting-review" ||
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
			budget: terminalBudget(work.budget, "completed"),
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

	private async failWork(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): Promise<WorkView> {
		if (meta.actor !== "user" && meta.actor !== "conclave") {
			throw this.error(
				"forbidden",
				"Only User or Conclave can fail Work explicitly.",
				false,
				"Use an authorized actor.",
			);
		}
		if (["succeeded", "failed", "cancelled"].includes(work.state)) {
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
			state: "failed",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "failed", endedAt: new Date().toISOString() },
			observer: undefined,
			observerInFlight: false,
			budget: terminalBudget(work.budget, "failed"),
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

	private async recoverRuntime(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): Promise<WorkView> {
		this.requireActor(meta, "user");
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

	private recoverCancelled(
		work: WorkView,
		meta: CommandMeta,
		onRecoveryUpdate?: (update: RecoveryUpdate) => void,
	): WorkView {
		this.requireActor(meta, "user");
		onRecoveryUpdate?.({ stage: "checking", message: "Preparing the cancelled Work for recovery." });
		if (work.state !== "cancelled") {
			throw this.error(
				"invalid-state",
				"Only cancelled Work can be recovered.",
				false,
				"Inspect the Work state before recovering it.",
			);
		}
		onRecoveryUpdate?.({ stage: "finishing", message: "Returning the recovered Work to admission." });
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "submitted",
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
			payload: { action: "recover", previousState: work.state },
			projection: next,
			summary: "Cancelled Work was recovered and returned to admission.",
			effects: [schedulerEffect(work.workId, next.revision)],
		}).projection;
	}

	private async cancel(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "user");
		if (["succeeded", "failed", "cancelled"].includes(work.state)) {
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
			state: "cancelled",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "stopped", endedAt: new Date().toISOString() },
			observer: undefined,
			observerInFlight: false,
			budget: terminalBudget(work.budget, "stopped"),
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
				"Use the role-bound application adapter.",
			);
		}
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
				"Configure a role-scoped model and supported thinking level.",
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
		scope: input.scope?.trim() || "Repository changes required by the objective.",
		acceptanceCriteria: input.acceptanceCriteria.map((entry) => assertNonBlank(entry, "acceptanceCriteria item")),
		constraints: (input.constraints ?? []).map((entry) => assertNonBlank(entry, "constraints item")),
		validation: (input.validation ?? ["Run the project's configured validation commands."]).map((entry) =>
			assertNonBlank(entry, "validation item"),
		),
		maxTokens,
	};
}

function executionDriveKey(workId: string, execution: Execution): string {
	return `${workId}:${execution.executionId}:${execution.pi?.sessionId ?? "unbound"}`;
}

function runtimeAction(work: WorkView, runtimeState: RuntimeState): string {
	if (work.execution === undefined || !["running", "awaiting-review"].includes(work.execution.state))
		return work.nextAction;
	if (runtimeState === "unreachable") return "Executor runtime is unreachable; recover it from Actions.";
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

function addTokenUsage(previous: TokenUsage | undefined, current: TokenUsage): TokenUsage {
	return {
		inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
		outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
		cacheHitTokens: (previous?.cacheHitTokens ?? 0) + current.cacheHitTokens,
		cacheMissTokens: (previous?.cacheMissTokens ?? 0) + current.cacheMissTokens,
	};
}

function terminalBudget(budget: WorkBudget, state: Execution["state"]): WorkBudget {
	if (!["completed", "failed", "stopped", "blocked"].includes(state)) {
		return budget;
	}
	return { ...budget, reservedTokens: 0, consumedTokens: budget.consumedTokens + budget.reservedTokens };
}

function roleSessionPath(projectPath: string, role: "conclave" | "observer", workId?: string): string {
	const projectKey = createHash("sha256").update(projectPath).digest("hex").slice(0, 24);
	const suffix =
		workId === undefined ? role : `${role}-${createHash("sha256").update(workId).digest("hex").slice(0, 24)}`;
	return join(tmpdir(), "khala-sessions", projectKey, `khala-${suffix}-session.jsonl`);
}

function schedulerEffect(workId: string, revision: number) {
	return { effectId: `conclave-wake:${workId}:${revision}`, kind: "conclave-wake", payload: { workId } };
}

function executorEffect(workId: string, revision: number) {
	return { effectId: `executor-wake:${workId}:${revision}`, kind: "executor-wake", payload: { workId } };
}

function observerEffect(workId: string, revision: number) {
	return { effectId: `observer-wake:${workId}:${revision}`, kind: "observer-wake", payload: { workId } };
}

function feedbackEffect(workId: string, revision: number, feedback: readonly string[]) {
	return { effectId: `feedback-wake:${workId}:${revision}`, kind: "feedback-wake", payload: { workId, feedback } };
}

function sandboxCleanupEffect(workId: string, executionId: string, sandbox: Execution["sandbox"]) {
	return {
		effectId: `workspace-cleanup:${workId}:orphan-${executionId}`,
		kind: "workspace-cleanup",
		payload: { workId, path: sandbox.path, baseCommit: sandbox.baseCommit, branch: sandbox.branch },
	};
}

function cleanupEffect(workId: string, execution: Execution) {
	return {
		effectId: `workspace-cleanup:${workId}:${execution.executionId}`,
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
			sessionId: execution.pi.sessionId,
			sessionPath: execution.pi.sessionPath,
			processGroupId: execution.pi.processGroupId,
			processStartTime: execution.pi.processStartTime,
			processMarker: execution.pi.processMarker,
		},
	};
}

function observerCleanupEffect(workId: string, binding: RuntimeBinding) {
	return {
		effectId: `observer-cleanup:${workId}:${binding.sessionId}`,
		kind: "observer-cleanup",
		payload: {
			workId,
			sessionId: binding.sessionId,
			sessionPath: binding.sessionPath,
			processGroupId: binding.processGroupId,
			processStartTime: binding.processStartTime,
			processMarker: binding.processMarker,
		},
	};
}

function observerEffects(workId: string, revision: number, binding: RuntimeBinding | undefined) {
	const effects = [schedulerEffect(workId, revision)];
	if (binding !== undefined) effects.push(observerCleanupEffect(workId, binding));
	return effects;
}

function lifecycleEffects(
	workId: string,
	revision: number,
	execution: Execution | undefined,
	observer?: RuntimeBinding,
	wakeConclave = true,
) {
	const effects: Array<
		| ReturnType<typeof schedulerEffect>
		| ReturnType<typeof cleanupEffect>
		| ReturnType<typeof executorStopEffect>
		| ReturnType<typeof observerCleanupEffect>
	> = [];
	if (wakeConclave) effects.push(schedulerEffect(workId, revision));
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

function readTextList(input: ActionInput | undefined, key: "evidence" | "feedback"): readonly string[] {
	const value = key === "evidence" ? input?.evidence : input?.feedback;
	if (value === undefined) throw new ActionInputError(`Action input ${key} must be a list of text.`);
	return value.map((entry) => requiredNonBlank(entry, `${key} item`));
}

function readSignalKind(input: ActionInput | undefined): Signal["kind"] {
	const value = requiredText(input?.kind, "kind");
	if (value !== "progress" && value !== "blocked" && value !== "ready") {
		throw new ActionInputError(`Signal kind ${value} is invalid.`);
	}
	return value;
}

function readDecision(input: ActionInput | undefined): "continue" | "replace" | "handoff" | "reject" {
	const value = requiredText(input?.decision, "decision");
	if (value !== "continue" && value !== "replace" && value !== "handoff" && value !== "reject") {
		throw new ActionInputError(`Verdict decision ${value} is invalid.`);
	}
	return value;
}

function readReviewStatus(input: ActionInput | undefined): "changes-requested" | "merged" | "closed" {
	const value = requiredText(input?.status, "status");
	if (value !== "changes-requested" && value !== "merged" && value !== "closed") {
		throw new ActionInputError(`Review status ${value} is invalid.`);
	}
	return value;
}

function oraclePayload(result: OracleResult): JsonObject {
	return {
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

function observationKey(workId: string, observation: ProviderObservation): string {
	return `${workId}:${observation.kind}:${observation.providerId}`;
}

function observationFingerprint(observation: ProviderObservation): string {
	return JSON.stringify({
		kind: observation.kind,
		providerId: observation.providerId,
		status: observation.status,
		summary: observation.summary,
		repository: observation.repository,
		sourceBranch: observation.sourceBranch,
		targetBranch: observation.targetBranch,
		headCommit: observation.headCommit,
		mergeCommit: observation.mergeCommit,
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function resultText<T>(result: ServiceResult<T>): string {
	return "error" in result ? `${result.error.code}: ${result.error.summary}` : "The command was applied.";
}
