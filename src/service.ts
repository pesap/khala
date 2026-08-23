import { randomUUID } from "node:crypto";
import { type ArchiveAppend, type ArchivePort, RevisionConflict } from "./archive.js";
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
	type ServiceResult,
	type Signal,
	type SubmitWorkInput,
	type WorkBudget,
	type WorkState,
	type WorkSummary,
	type WorkTerms,
	type WorkView,
} from "./model.js";
import type { OracleResult, ServicePorts } from "./ports.js";

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
}>;

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
	private readonly archive: ArchivePort;
	private readonly ports: ServicePorts;
	private readonly options: ServiceOptions;

	constructor(archive: ArchivePort, ports: ServicePorts, options: ServiceOptions) {
		this.archive = archive;
		this.ports = ports;
		this.options = options;
	}

	submitWork(input: SubmitWorkInput, meta: CommandMeta): WorkView {
		this.requireActor(meta, "user");
		const prior = this.archive.findCommand(meta.commandId);
		if (prior !== undefined) {
			return prior.projection;
		}
		const workId = input.workId?.trim() || randomUUID();
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

	readRecords(query: RecordQuery | undefined, meta: CommandMeta, cursor?: string): Page<RecordView> {
		this.requireReadableActor(meta.actor);
		const normalized = this.normalizeRecordQuery(query, meta.actor);
		return this.archive.query(normalized, cursor);
	}

	availableActions(workId: string, actor: Actor, revision?: number): readonly Action[] {
		const work = this.inspectWork(workId);
		const expected = revision ?? work.revision;
		const actions: Action[] = [];
		if (actor === "user") {
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
					(work.state === "submitted" || work.state === "needs-input") && work.terms.context.length === 0,
					"Gather missing repository context",
					work.terms.context.length === 0 ? undefined : "Work already contains context.",
				),
			);
			actions.push(
				this.action(
					"start-execution",
					work,
					expected,
					(work.state === "queued" && work.mission !== undefined && work.execution === undefined) ||
						(work.state === "active" &&
							work.mission !== undefined &&
							work.execution !== undefined &&
							["failed", "blocked", "stopped"].includes(work.execution.state)),
					"Start Execution",
					work.state === "queued" ||
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
			return {
				error: {
					code: "invalid-input",
					summary: error instanceof Error ? error.message : "The action input was invalid.",
					retryable: false,
					remediation: "Correct the action input and retry after rereading the Work.",
					evidenceRefs: [],
				},
			};
		}
	}

	async wakeConclave(workId: string, commandId: string, meta: CommandMeta): Promise<void> {
		this.requireActor(meta, "conclave");
		const work = this.inspectWork(workId);
		this.validateModel("conclave", this.options.conclaveModel, this.options.conclaveThinking);
		const binding = await this.ports.runtime.ensureSession({
			cwd: this.options.projectPath,
			model: this.options.conclaveModel,
			thinking: this.options.conclaveThinking,
			role: "conclave",
			promptIdentity: this.options.conclavePromptIdentity,
			tools: ["khala_read_archive", "khala_perform_action", "khala_run_oracle"],
		});
		await this.ports.runtime.send(
			binding,
			`Process queued Work ${work.workId}. Read the Archive first. Admit it if its Mission terms are complete, then start its Execution when budget permits. Never treat this message as authority.`,
		);
		this.archive.completeEffect(`conclave-wake:${work.workId}`);
		this.heartbeat.set(commandId, `Conclave wake sent for Work ${work.workId}.`);
	}

	async processPendingEffects(): Promise<void> {
		for (const effect of this.archive.pendingEffects()) {
			if (effect.kind !== "conclave-wake") {
				continue;
			}
			const workId = readEffectWorkId(effect.payload);
			try {
				const work = this.inspectWork(workId);
				await this.wakeConclave(workId, `outbox:${effect.effectId}:${work.revision}`, {
					actor: "conclave",
					commandId: `outbox:${effect.effectId}`,
					expectedWorkRevision: work.revision,
					schemaVersion: 1,
				});
			} catch (error) {
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
		}
	}

	async pollProvider(workId: string, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "monitor");
		let work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		if (work.reviewRequest === undefined) {
			throw this.error(
				"invalid-state",
				"Provider polling requires a review request.",
				false,
				"Publish a draft review request first.",
			);
		}
		const observations = [...(await this.ports.codeHost.poll(work.reviewRequest))];
		const outcome = await this.ports.codeHost.inspectOutcome(work.reviewRequest);
		if (outcome !== undefined) {
			observations.push(outcome);
		}
		for (const [index, observation] of observations.entries()) {
			work = this.recordObservation(workId, observation, {
				...meta,
				commandId: `${meta.commandId}:${index}`,
				expectedWorkRevision: work.revision,
			});
		}
		return work;
	}

	async recoverWork(workId: string, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		const work = this.inspectWork(workId);
		if (work.execution === undefined || work.execution.pi === undefined || work.mission === undefined) {
			return work;
		}
		const execution = work.execution;
		const persistedBinding = execution.pi;
		if (persistedBinding === undefined) {
			return work;
		}
		const sessionPath = persistedBinding.sessionPath;
		this.validateModel("executor", execution.model, execution.thinking);
		try {
			const binding = await this.ports.runtime.ensureSession({
				cwd: execution.sandbox.path,
				model: execution.model,
				thinking: execution.thinking,
				role: "executor",
				promptIdentity: execution.promptIdentity,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "khala_read_archive", "khala_record_signal"],
				sessionPath,
			});
			const recovered: Execution = { ...execution, pi: binding };
			const next: WorkView = {
				...work,
				revision: work.revision + 1,
				execution: recovered,
				nextAction: "Executor runtime reconciled.",
			};
			return this.append({
				meta,
				kind: "execution",
				workId,
				missionId: work.mission.missionId,
				executionId: execution.executionId,
				payload: recovered,
				projection: next,
				summary: `Execution ${execution.executionId} runtime was reconciled.`,
			}).projection;
		} catch (error) {
			const failed: Execution = { ...execution, state: "failed", endedAt: new Date().toISOString() };
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
			}).projection;
		}
	}

	recordObservation(workId: string, observation: ProviderObservation, meta: CommandMeta): WorkView {
		this.requireActor(meta, "monitor");
		const prior = this.archive.findCommand(meta.commandId);
		if (prior !== undefined) {
			if (prior.record.workId !== workId) {
				throw this.error(
					"invalid-input",
					`Command ${meta.commandId} was already used for Work ${prior.record.workId}.`,
					false,
					"Use a new command ID for this Work.",
				);
			}
			return prior.projection;
		}
		const work = this.inspectWork(workId);
		this.checkRevision(work, meta);
		const key = observationKey(workId, observation);
		const fingerprint = observationFingerprint(observation);
		const previous = this.heartbeat.get(key) ?? this.persistedObservationFingerprint(workId, work, observation);
		this.heartbeat.set(key, fingerprint);
		if (previous === fingerprint) {
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
			nextAction: work.nextAction,
		};
		return this.append({
			meta,
			kind: "observation",
			workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: nextObservation,
			projection: next,
			summary: `Provider observation changed: ${observation.kind}.`,
		}).projection;
	}

	recordWakeFailure(workId: string, message: string, meta: CommandMeta): WorkView {
		this.requireActor(meta, "conclave");
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
		await this.ports.runtime.close();
		this.archive.close();
	}

	private persistedObservationFingerprint(
		workId: string,
		work: WorkView,
		observation: ProviderObservation,
	): string | undefined {
		if (work.lastObservation !== undefined && sameObservation(work.lastObservation, observation)) {
			return observationFingerprint(work.lastObservation);
		}
		const records = this.archive.query({ workId, kinds: ["observation"] }).items;
		for (let index = records.length - 1; index >= 0; index -= 1) {
			const payload = records[index]?.payload;
			if (
				isJsonObject(payload) &&
				payload["kind"] === observation.kind &&
				payload["providerId"] === observation.providerId &&
				payload["status"] === observation.status &&
				payload["summary"] === observation.summary
			) {
				return observationFingerprint(observation);
			}
		}
		return undefined;
	}

	private async performOrThrow(command: ActionCommand): Promise<WorkView> {
		const work = this.inspectWork(command.workId);
		this.checkRevision(work, command.meta);
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
			case "amend-budget":
				return this.amendBudget(work, command.meta, command.input);
			case "fail-work":
				return this.failWork(work, command.meta, command.input);
		}
	}

	private async launchObserver(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		if (work.state !== "submitted" && work.state !== "needs-input") {
			throw this.error(
				"invalid-state",
				"Only submitted Work can launch an Observer.",
				false,
				"Inspect the current Work state.",
			);
		}
		if (work.terms.context.length > 0) {
			throw this.error(
				"invalid-state",
				"Work already contains context for admission.",
				false,
				"Admit the Work instead.",
			);
		}
		if (this.options.observerModel.length === 0) {
			throw this.error(
				"external-failure",
				"No Observer model is configured.",
				false,
				"Configure observerModel or provide the child Pi model explicitly.",
			);
		}
		this.validateModel("observer", this.options.observerModel, this.options.observerThinking);
		const binding = await this.ports.runtime.ensureSession({
			cwd: this.options.projectPath,
			model: this.options.observerModel,
			thinking: this.options.observerThinking,
			role: "observer",
			promptIdentity: this.options.observerPromptIdentity,
			tools: ["khala_read_archive", "khala_record_assessment"],
		});
		await this.ports.runtime.send(
			binding,
			`Inspect Work ${work.workId} read-only. Record exactly one bounded assessment with concrete repository evidence, then stop.`,
		);
		return this.inspectWork(work.workId);
	}

	private recordAssessment(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "observer");
		this.checkRevision(work, meta);
		const existing = this.archive.query({ workId: work.workId, kinds: ["assessment"] }).items;
		if (existing.length > 0) {
			throw this.error(
				"invalid-state",
				"This Work already has an Observer assessment.",
				false,
				"Stop the Observer and let Conclave reread the Archive.",
			);
		}
		const summary = assertNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
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
			missionId: randomUUID(),
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
		}).projection;
	}

	private async startExecution(work: WorkView, meta: CommandMeta): Promise<WorkView> {
		this.requireActor(meta, "conclave");
		if (work.mission === undefined || (work.state !== "queued" && work.state !== "active")) {
			throw this.error(
				"invalid-state",
				"Only admitted queued Work can start an Execution.",
				false,
				"Admit the Work first.",
			);
		}
		if (work.execution !== undefined && ["queued", "running", "awaiting-review"].includes(work.execution.state)) {
			return work;
		}
		const projects = this.archive.listProjects();
		if (work.state === "queued") {
			const firstQueued = projects
				.filter((candidate) => candidate.state === "queued")
				.sort((left, right) => left.queuedSequence - right.queuedSequence)[0];
			if (firstQueued !== undefined && firstQueued.workId !== work.workId) {
				return work;
			}
		}
		const activeCount = projects.filter(
			(candidate) => candidate.execution?.state === "running" || candidate.execution?.state === "queued",
		).length;
		const allowance = Math.max(1, Math.floor(work.budget.maxTokens / 2));
		if (activeCount >= this.options.maxConcurrentExecutions) {
			return work;
		}
		if (work.budget.reservedTokens + work.budget.consumedTokens + allowance > work.budget.maxTokens) {
			return work;
		}
		this.validateModel("executor", this.options.executorModel, this.options.executorThinking);
		const executionId = randomUUID();
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
			budget: { ...work.budget, reservedTokens: work.budget.reservedTokens + allowance },
			reviewRequest: undefined,
			lastSignal: undefined,
			lastObservation: undefined,
			execution,
			nextAction: "Executor is starting.",
		};
		const queuedResult = this.append({
			meta,
			kind: "execution",
			workId: work.workId,
			missionId: work.mission.missionId,
			executionId,
			payload: execution,
			projection: queued,
			summary: `Execution ${executionId} queued.`,
		});
		if (queuedResult.duplicate) {
			return queuedResult.projection;
		}
		try {
			const binding = await this.ports.runtime.ensureSession({
				cwd: sandbox.path,
				model: execution.model,
				thinking: execution.thinking,
				role: "executor",
				promptIdentity: execution.promptIdentity,
				tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "khala_read_archive", "khala_record_signal"],
			});
			const running: Execution = { ...execution, state: "running", pi: binding, startedAt: new Date().toISOString() };
			const next: WorkView = {
				...queuedResult.projection,
				revision: queuedResult.projection.revision + 1,
				execution: running,
				nextAction: "Executor is working.",
			};
			return this.append({
				meta: {
					...meta,
					commandId: `${meta.commandId}:running`,
					expectedWorkRevision: queuedResult.projection.revision,
				},
				kind: "execution",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId,
				payload: running,
				projection: next,
				summary: `Execution ${executionId} is running.`,
			}).projection;
		} catch (error) {
			const failed: Execution = { ...execution, state: "failed", endedAt: new Date().toISOString() };
			const next: WorkView = {
				...queuedResult.projection,
				revision: queuedResult.projection.revision + 1,
				state: "active",
				budget: { ...queuedResult.projection.budget, reservedTokens: 0 },
				execution: failed,
				nextAction: "Execution failed; Conclave may replace it.",
			};
			this.append({
				meta: {
					...meta,
					commandId: `${meta.commandId}:failed`,
					expectedWorkRevision: queuedResult.projection.revision,
				},
				kind: "error",
				workId: work.workId,
				missionId: work.mission.missionId,
				executionId,
				payload: { message: error instanceof Error ? error.message : String(error) },
				projection: next,
				summary: `Execution ${executionId} failed to start.`,
			});
			throw this.error(
				"external-failure",
				"The Executor runtime could not be started.",
				true,
				"Inspect the failure evidence and retry the Execution.",
			);
		}
	}

	private recordSignal(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "executor");
		const execution = this.requireExecution(work, "running");
		const kind = readSignalKind(input);
		const summary = assertNonBlank(requiredText(input?.summary, "summary"), "summary");
		const evidence = readTextList(input, "evidence");
		if (kind === "ready" && work.reviewRequest === undefined) {
			throw this.error(
				"invalid-state",
				"A ready Signal requires a draft review request.",
				false,
				"Create the review request first.",
			);
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
		if (work.reviewRequest !== undefined) {
			return work;
		}
		const request = await this.ports.codeHost.ensureReviewRequest({
			workId: work.workId,
			mission: work.mission,
			execution,
			terms: work.terms,
			sandbox: execution.sandbox,
			targetBranch: this.options.targetBranch,
			draftMarker: `Khala-Work: ${work.workId}`,
		});
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
		const subject = assertNonBlank(requiredText(input?.subject, "subject"), "subject");
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
		const reason = assertNonBlank(requiredText(input?.reason, "reason"), "reason");
		const signalId = assertNonBlank(requiredText(input?.signalId, "signalId"), "signalId");
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
		if (decision !== "continue") {
			await this.stopExecution(execution);
		}
		const result = this.append({
			meta,
			kind: "verdict",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: execution.executionId,
			payload: verdictPayload,
			projection: next,
			summary: `Conclave Verdict: ${decision}.`,
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

	private recordReview(work: WorkView, meta: CommandMeta, input: ActionInput | undefined): WorkView {
		this.requireActor(meta, "user");
		if (work.state !== "awaiting-review" || work.reviewRequest === undefined) {
			throw this.error("invalid-state", "Work is not awaiting a review.", false, "Wait for a handoff Verdict.");
		}
		const status = readReviewStatus(input);
		const feedback = readTextList(input, "feedback");
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
			execution:
				work.execution === undefined
					? undefined
					: status === "changes-requested"
						? { ...work.execution, state: "running" }
						: work.execution,
			state: status === "changes-requested" ? "active" : "awaiting-review",
			nextAction:
				status === "merged"
					? "Conclave must verify provider merge evidence and record the Outcome."
					: status === "changes-requested"
						? "Executor may address authorized review feedback."
						: "Review closed without acceptance.",
		};
		return this.append({
			meta,
			kind: "observation",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { status, feedback },
			projection: next,
			summary: `User review recorded: ${status}.`,
			evidenceRefs: feedback,
		}).projection;
	}

	private recordOutcome(work: WorkView, meta: CommandMeta): WorkView {
		this.requireActor(meta, "conclave");
		const reviewRequest = work.reviewRequest;
		const lastObservation = work.lastObservation;
		if (
			work.state !== "awaiting-review" ||
			reviewRequest === undefined ||
			reviewRequest.status !== "merged" ||
			lastObservation === undefined ||
			lastObservation.kind !== "provider-outcome" ||
			lastObservation.providerId !== reviewRequest.providerId
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
			payload: { reviewRequestId: reviewRequest.providerId, mergeEvidence: lastObservation.summary },
			projection: next,
			summary: "Provider-confirmed merge accepted as the Work Outcome.",
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
		const reason = assertNonBlank(requiredText(input?.reason, "reason"), "reason");
		await this.stopExecution(work.execution);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "failed",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "failed", endedAt: new Date().toISOString() },
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
		await this.stopExecution(work.execution);
		const next: WorkView = {
			...work,
			revision: work.revision + 1,
			state: "cancelled",
			execution:
				work.execution === undefined
					? undefined
					: { ...work.execution, state: "stopped", endedAt: new Date().toISOString() },
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

	private normalizeRecordQuery(query: RecordQuery | undefined, actor: Actor): RecordQuery {
		if (actor === "user" || actor === "conclave" || actor === "monitor") {
			return query ?? {};
		}
		const workId = query?.workId;
		if (workId === undefined) {
			throw this.error("forbidden", "This role must read one Work at a time.", false, "Supply the bound Work ID.");
		}
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

	private async stopExecution(execution: Execution | undefined): Promise<void> {
		if (execution?.pi === undefined || !["running", "blocked", "awaiting-review"].includes(execution.state)) {
			return;
		}
		try {
			await this.ports.runtime.requestStop(execution.pi);
		} catch (error) {
			throw this.error(
				"external-failure",
				error instanceof Error ? `Executor stop failed: ${error.message}` : "Executor stop failed.",
				true,
				"Reconcile the Executor runtime before retrying the lifecycle action.",
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

	private error(
		code: ErrorEnvelope["code"],
		summary: string,
		retryable: boolean,
		remediation: string,
	): ApplicationError {
		return new ApplicationError({ code, summary, retryable, remediation, evidenceRefs: [] });
	}
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

function terminalBudget(budget: WorkBudget, state: Execution["state"]): WorkBudget {
	if (!["completed", "failed", "stopped", "blocked"].includes(state)) {
		return budget;
	}
	return { ...budget, reservedTokens: 0, consumedTokens: budget.consumedTokens + budget.reservedTokens };
}

function readEffectWorkId(payload: JsonObject): string {
	const value = payload["workId"];
	if (value === undefined || value !== String(value) || value.trim().length === 0) {
		throw new Error("Conclave wake effect is missing a Work ID.");
	}
	return String(value);
}

function requiredText(value: string | undefined, key: string): string {
	if (value === undefined) {
		throw new Error(`Action input ${key} must be text.`);
	}
	return value;
}

function readTextList(input: ActionInput | undefined, key: "evidence" | "feedback"): readonly string[] {
	const value = key === "evidence" ? input?.evidence : input?.feedback;
	if (value === undefined) {
		throw new Error(`Action input ${key} must be a list of text.`);
	}
	return value.map((entry) => assertNonBlank(entry, `${key} item`));
}

function readSignalKind(input: ActionInput | undefined): Signal["kind"] {
	const value = requiredText(input?.kind, "kind");
	if (value !== "progress" && value !== "blocked" && value !== "ready") {
		throw new Error(`Signal kind ${value} is invalid.`);
	}
	return value;
}

function readDecision(input: ActionInput | undefined): "continue" | "replace" | "handoff" | "reject" {
	const value = requiredText(input?.decision, "decision");
	if (value !== "continue" && value !== "replace" && value !== "handoff" && value !== "reject") {
		throw new Error(`Verdict decision ${value} is invalid.`);
	}
	return value;
}

function readReviewStatus(input: ActionInput | undefined): "changes-requested" | "merged" | "closed" {
	const value = requiredText(input?.status, "status");
	if (value !== "changes-requested" && value !== "merged" && value !== "closed") {
		throw new Error(`Review status ${value} is invalid.`);
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
		work.lastObservation?.kind === "provider-outcome" &&
		work.lastObservation.providerId === work.reviewRequest.providerId
	);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

export function resultText<T>(result: ServiceResult<T>): string {
	return "error" in result ? `${result.error.code}: ${result.error.summary}` : "The command was applied.";
}
