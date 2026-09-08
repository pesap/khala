import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { type ArchiveAppend, type ArchivePort, CommandReuseConflict, RevisionConflict } from "./archive.js";
import {
	type Action,
	type Actor,
	type CommandMeta,
	type ErrorEnvelope,
	type Execution,
	type GovernedRole,
	type JsonValue,
	type Page,
	type RecordQuery,
	type RecordSummaryView,
	type RecordView,
	type ServiceResult,
	type WorkSummary,
	type WorkView,
} from "./model.js";
import type { ModelCatalogPort } from "./ports.js";
import { ActionInputError, ApplicationError } from "./service-contracts.js";
import { capabilityParts, externalFailureEnvelope, type RoleCapability } from "./service-foundation-policy.js";
import { matchesExecutorCapability, readCapabilityRole, workSummary } from "./service-lifecycle-policy.js";
import { isJsonObject, normalizeScopedQuery } from "./service-runtime-policy.js";
import {
	isScopedArchiveActor,
	isUnscopedArchiveActor,
	readCapabilityText,
	roleActionRemediation,
} from "./service-state-policy.js";

export type ArchiveCoreAppendInput = Readonly<{
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
	invocationLimit?: number | undefined;
}>;

export type ArchiveCoreAppendResult = Readonly<{ projection: WorkView; duplicate: boolean }>;

export class ArchiveCore {
	private readonly archive: ArchivePort;
	private readonly models: ModelCatalogPort;
	private readonly rolePublicKey: KeyObject;

	constructor(archive: ArchivePort, models: ModelCatalogPort, rolePublicKey: string) {
		this.archive = archive;
		this.models = models;
		this.rolePublicKey = createPublicKey({
			key: Buffer.from(rolePublicKey, "base64url"),
			format: "der",
			type: "spki",
		});
	}

	append(input: ArchiveCoreAppendInput): ArchiveCoreAppendResult {
		try {
			const result = this.archive.append({
				commandId: input.meta.commandId,
				commandFingerprint: input.meta.commandFingerprint,
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
				invocationLimit: input.invocationLimit,
			});
			return { projection: result.projection, duplicate: result.duplicate };
		} catch (error) {
			if (error instanceof RevisionConflict)
				throw this.error(
					"revision-conflict",
					error.message,
					true,
					"Reread the Work and retry with its current revision.",
				);
			throw error;
		}
	}

	listWork(): readonly WorkSummary[] {
		const projects = this.archive.listProjects();
		const queue = projects
			.filter((work) => work.state === "queued")
			.sort((left, right) => left.queuedSequence - right.queuedSequence);
		const queuePositions = new Map(queue.map((work, index) => [work.workId, index + 1]));
		return projects.map((work) => workSummary(work, queuePositions));
	}

	inspectWork(workId: string): WorkView {
		const work = this.archive.project(workId);
		if (work === undefined)
			throw this.error(
				"not-found",
				`Work ${workId} was not found.`,
				false,
				"Read the Work list and choose an existing ID.",
			);
		return work;
	}

	readRecords(query: RecordQuery | undefined, meta: CommandMeta, cursor?: string): Page<RecordView> {
		const capability = this.readArchiveCapability(meta);
		const normalized = this.normalizeRecordQuery(query, meta.actor, capability);
		const page = this.archive.query(normalized, cursor);
		return this.readRecordsForCapability(page, normalized, capability);
	}

	readRecordSummaries(query: RecordQuery | undefined, meta: CommandMeta): Page<RecordSummaryView> {
		const capability = this.readArchiveCapability(meta);
		const normalized = this.normalizeRecordQuery(query, meta.actor, capability);
		return this.archive.querySummaries(normalized, this.summaryVisibleExecutionId(capability));
	}

	requireActor(meta: CommandMeta, actor: Actor): void {
		if (meta.actor === actor) return;
		throw this.error(
			"forbidden",
			`Only the ${actor} role may perform this action.`,
			false,
			roleActionRemediation(meta.actor, actor),
		);
	}

	requireAnyActor(meta: CommandMeta, actors: readonly Actor[]): void {
		if (actors.includes(meta.actor)) return;
		throw this.error(
			"forbidden",
			`Only ${actors.join(" or ")} roles may perform this action.`,
			false,
			"Use the role-bound application adapter.",
		);
	}

	checkRevision(work: WorkView, meta: CommandMeta): void {
		if (meta.expectedWorkRevision === work.revision) return;
		throw this.error(
			"revision-conflict",
			`Work ${work.workId} is at revision ${work.revision}.`,
			true,
			"Reread the Work and retry.",
		);
	}

	requireExecution(work: WorkView, state?: Execution["state"]): Execution {
		if (work.execution !== undefined && (state === undefined || work.execution.state === state)) return work.execution;
		throw this.error(
			"invalid-state",
			"The current Execution does not satisfy the requested state.",
			false,
			"Inspect the current Execution before acting.",
		);
	}

	requireRoleBinding(meta: CommandMeta, work: WorkView): void {
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

	validateModel(role: GovernedRole, model: string, thinking: string): void {
		try {
			this.assertModelConfiguration(role, model, thinking);
		} catch (error) {
			throw this.error(
				"external-failure",
				error instanceof Error ? error.message : "The configured model could not be resolved.",
				false,
				"Open /khala, press r, configure a role-scoped model and supported thinking level, then retry admission.",
			);
		}
	}

	action(
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

	inputEnvelope(summary: string): ErrorEnvelope {
		return {
			code: "invalid-input",
			summary,
			retryable: false,
			remediation: "Correct the action input and retry.",
			evidenceRefs: [],
		};
	}

	error(code: ErrorEnvelope["code"], summary: string, retryable: boolean, remediation: string): ApplicationError {
		return new ApplicationError({ code, summary, retryable, remediation, evidenceRefs: [] });
	}

	performError<T>(error: Error): ServiceResult<T> {
		if (error instanceof ApplicationError) return { error: error.envelope };
		if (error instanceof CommandReuseConflict || error instanceof ActionInputError)
			return { error: this.inputEnvelope(error.message) };
		return { error: externalFailureEnvelope(error.message) };
	}

	private readArchiveCapability(meta: CommandMeta): RoleCapability | undefined {
		this.requireReadableActor(meta.actor);
		if (isUnscopedArchiveActor(meta.actor)) return undefined;
		const capability = this.requireCapability(meta);
		this.assertArchiveCapabilityActor(capability, meta.actor);
		this.scopeArchiveCapability(meta, capability);
		return capability;
	}

	private assertArchiveCapabilityActor(capability: RoleCapability, actor: Actor): void {
		if (capability.role === actor) return;
		throw this.error(
			"forbidden",
			"The role capability does not match the actor.",
			false,
			"Use the bound role session.",
		);
	}

	private scopeArchiveCapability(meta: CommandMeta, capability: RoleCapability): void {
		if (!isScopedArchiveActor(meta.actor)) return;
		this.requireScopedCapability(meta, capability, this.inspectWork(capability.workId ?? ""));
	}

	private readRecordsForCapability(
		page: Page<RecordView>,
		query: RecordQuery,
		capability: RoleCapability | undefined,
	): Page<RecordView> {
		if (capability?.role !== "executor") return page;
		return this.readExecutorRecords(page, query, capability.executionId);
	}

	private summaryVisibleExecutionId(capability: RoleCapability | undefined): string | undefined {
		if (capability?.role !== "executor") return undefined;
		return this.executorRecordExecutionId(capability.executionId);
	}

	private readExecutorRecords(
		page: Page<RecordView>,
		query: RecordQuery,
		boundExecutionId: string | undefined,
	): Page<RecordView> {
		const executionId = this.executorRecordExecutionId(boundExecutionId);
		const items = page.items.filter((record) => record.executionId === undefined || record.executionId === executionId);
		let nextCursor = page.nextCursor;
		while (items.length < 100 && nextCursor !== undefined) {
			const nextPage = this.archive.query(query, nextCursor);
			items.push(
				...nextPage.items.filter((record) => record.executionId === undefined || record.executionId === executionId),
			);
			nextCursor = nextPage.nextCursor;
		}
		return { ...page, items, nextCursor };
	}

	private executorRecordExecutionId(executionId: string | undefined): string {
		if (executionId !== undefined) return executionId;
		throw this.error(
			"forbidden",
			"The Executor capability is missing its Execution scope.",
			false,
			"Use the bound Executor session.",
		);
	}

	private normalizeRecordQuery(
		query: RecordQuery | undefined,
		actor: Actor,
		capability: RoleCapability | undefined,
	): RecordQuery {
		const unscopedActors: readonly Actor[] = ["user", "monitor"];
		if (unscopedActors.includes(actor)) return query ?? {};
		const { workId, executionId } = capability ?? {};
		return normalizeScopedQuery(query, actor, workId, executionId, (summary, remediation) =>
			this.error("forbidden", summary, false, remediation),
		);
	}

	requireReadableActor(actor: Actor): void {
		if (["user", "conclave", "observer", "executor", "monitor"].includes(actor)) return;
		throw this.error("forbidden", "This role cannot read Archive records.", false, "Use an authorized role session.");
	}

	private assertModelConfiguration(role: GovernedRole, model: string, thinking: string): void {
		if (!this.models.listScoped(role).includes(model))
			throw new Error(`Model ${model} is not configured for the ${role} role.`);
		const resolved = this.models.resolve(model);
		if (!resolved.supportedThinking.includes(thinking))
			throw new Error(`Thinking level ${thinking} is not supported by model ${model}.`);
	}

	private requireScopedCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): void {
		if (meta.actor === "conclave") this.requireConclaveCapability(meta, capability, work);
		if (meta.actor === "executor") this.requireExecutorCapability(meta, capability, work);
		if (meta.actor === "observer") this.requireObserverCapability(meta, capability, work);
	}

	private requireConclaveCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): void {
		if (capability.workId === work.workId && meta.roleNonce === capability.nonce) return;
		throw this.error(
			"forbidden",
			"The Conclave session is not bound to this Work.",
			false,
			"Use the scheduled Conclave session.",
		);
	}

	private requireExecutorCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): void {
		if (matchesExecutorCapability(meta, capability, work)) return;
		throw this.error(
			"forbidden",
			"The Executor session is not bound to this Work Execution.",
			false,
			"Use the bound Executor session.",
		);
	}

	private requireObserverCapability(meta: CommandMeta, capability: RoleCapability, work: WorkView): void {
		const matches = [
			capability.workId === work.workId,
			meta.roleNonce === capability.nonce,
			capability.nonce === work.observer?.capabilityNonce,
		].every(Boolean);
		if (matches) return;
		throw this.error(
			"forbidden",
			"The Observer session is not bound to this Work.",
			false,
			"Use the bound Observer session.",
		);
	}

	private requireCapability(meta: CommandMeta): RoleCapability {
		const [encoded, signature] = capabilityParts(meta.roleToken, (message) =>
			this.error("forbidden", message, false, "Use the runtime-launched role session."),
		);
		const parsed = this.parseCapabilityPayload(encoded);
		if (!isJsonObject(parsed))
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		const role = readCapabilityRole(parsed["role"]);
		if (!this.validCapabilitySignature(role, encoded, signature))
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		return {
			role,
			workId: readCapabilityText(parsed["workId"]),
			executionId: readCapabilityText(parsed["executionId"]),
			nonce: readCapabilityText(parsed["nonce"]),
		};
	}

	private parseCapabilityPayload(encoded: string): JsonValue {
		try {
			// SAFETY: capability payloads are parsed as JsonValue before domain fields are inspected below.
			return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as JsonValue;
		} catch {
			throw this.error("forbidden", "The role capability is invalid.", false, "Use the runtime-launched role session.");
		}
	}

	private validCapabilitySignature(
		role: GovernedRole | undefined,
		encoded: string,
		signature: string,
	): role is GovernedRole {
		return (
			role !== undefined &&
			verify(null, Buffer.from(encoded, "utf8"), this.rolePublicKey, Buffer.from(signature, "base64url"))
		);
	}
}
