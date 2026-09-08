import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { persistRoleSetting } from "./config.js";
import { createDecisionEvidencePacket } from "./decision-evidence.js";
import { type RecoveryReport, recoverUserWork } from "./extension-recovery.js";
import {
	archiveToolResult,
	formatCommandError,
	renderArchiveToolResult,
	type ToolResult,
	throwIfAborted,
	toolError,
	toolErrorFromError,
	toolErrorText,
	toolOperation,
	toolResult,
} from "./extension-results.js";
import {
	meta,
	ROLE_FLAG,
	requireSessionRole,
	restrictedToolViolation,
	rolePromptFiles,
	sessionRole,
	setRoleTools,
} from "./extension-role.js";
import { type ApplicationModelRegistry, type ApplicationRuntime, createApplication } from "./factory.js";
import {
	type Actor,
	type JsonValue,
	type MutableRecordQuery,
	parseRecordKind,
	RECORD_KINDS,
	type RecordKind,
	type ServiceResult,
	WORK_STATES,
	type WorkView,
} from "./model.js";
import { ApplicationError } from "./service.js";
import { showKhala } from "./tui.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const submitSchema = Type.Object({
	workId: Type.Optional(Type.String()),
	title: Type.String({ minLength: 1 }),
	objective: Type.String({ minLength: 1 }),
	context: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String()),
	acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	constraints: Type.Optional(Type.Array(Type.String())),
	validation: Type.Optional(Type.Array(Type.String())),
	allowedPaths: Type.Optional(Type.Array(Type.String())),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
type SubmitParams = Static<typeof submitSchema>;

const readArchiveSchema = Type.Object({
	workId: Type.Optional(Type.String({ minLength: 1 })),
	missionId: Type.Optional(Type.String({ minLength: 1 })),
	cursor: Type.Optional(Type.String({ minLength: 1 })),
	kinds: Type.Optional(Type.Array(StringEnum(RECORD_KINDS))),
	executionId: Type.Optional(Type.String({ minLength: 1 })),
	states: Type.Optional(Type.Array(StringEnum(WORK_STATES))),
	from: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
});
type ReadArchiveParams = Static<typeof readArchiveSchema>;

const inspectRuntimeSchema = Type.Object({
	workId: Type.String({ minLength: 1 }),
	expectedWorkRevision: Type.Integer({ minimum: 0 }),
});
type InspectRuntimeParams = Static<typeof inspectRuntimeSchema>;

const actionInputSchema = Type.Object({
	runId: Type.Optional(Type.String({ minLength: 1 })),
	usage: Type.Optional(
		Type.Object({
			inputTokens: Type.Integer({ minimum: 0 }),
			outputTokens: Type.Integer({ minimum: 0 }),
			cacheHitTokens: Type.Integer({ minimum: 0 }),
			cacheMissTokens: Type.Integer({ minimum: 0 }),
		}),
	),
	kind: Type.Optional(StringEnum(["progress", "blocked", "ready"] as const)),
	summary: Type.Optional(Type.String({ minLength: 1 })),
	evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	decision: Type.Optional(StringEnum(["continue", "replace", "handoff", "reject"] as const)),
	reason: Type.Optional(Type.String({ minLength: 1 })),
	signalId: Type.Optional(Type.String({ minLength: 1 })),
	status: Type.Optional(StringEnum(["changes-requested", "merged", "closed"] as const)),
	feedback: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	title: Type.Optional(Type.String({ minLength: 1 })),
	objective: Type.Optional(Type.String({ minLength: 1 })),
	context: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String({ minLength: 1 })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	constraints: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	validation: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	allowedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	missing: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	observationId: Type.Optional(Type.String({ minLength: 1 })),
	subject: Type.Optional(Type.String({ minLength: 1 })),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
const performSchema = Type.Object({
	action: StringEnum([
		"admit",
		"request-input",
		"amend-terms",
		"amend-mission",
		"launch-observer",
		"record-assessment",
		"start-execution",
		"record-signal",
		"commit-sandbox",
		"run-validation",
		"create-review-request",
		"run-oracle",
		"verdict",
		"deliver-feedback",
		"record-review",
		"record-outcome",
		"cancel",
		"recover",
		"rename-work",
		"amend-budget",
		"reconcile-invocation",
		"fail-work",
	] as const),
	workId: Type.String({ minLength: 1 }),
	input: Type.Optional(actionInputSchema),
	expectedWorkRevision: Type.Integer({ minimum: 0 }),
});
type PerformParams = Static<typeof performSchema>;

type RuntimeState = Readonly<{ runtime: ApplicationRuntime; projectPath: string; trusted: boolean }>;
export default function khalaExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_FLAG, { description: "Khala role for an isolated child session", type: "string" });
	pi.on("tool_call", (event) => {
		const violation = restrictedToolViolation(pi, event);
		return violation === undefined ? undefined : { block: true, reason: violation };
	});
	let runtime: RuntimeState | undefined;
	let runtimeTransition: Promise<void> | undefined;
	let executorStatusTimer: ReturnType<typeof setInterval> | undefined;
	let userContext: ExtensionContext | undefined;

	const replaceRuntime = async (context: ExtensionContext, trusted: boolean): Promise<void> => {
		if (runtimeMatches(runtime, context.cwd, trusted)) return;
		if (executorStatusTimer !== undefined) clearInterval(executorStatusTimer);
		executorStatusTimer = undefined;
		const previous = runtime;
		runtime = undefined;
		if (previous !== undefined) await previous.runtime.service.close();
		runtime = createRuntimeState(context.cwd, trusted, context.modelRegistry);
	};
	const awaitRuntimeTransition = async (context: ExtensionContext, trusted: boolean): Promise<void> => {
		const queued = (runtimeTransition ?? Promise.resolve()).then(
			() => replaceRuntime(context, trusted),
			() => replaceRuntime(context, trusted),
		);
		runtimeTransition = queued;
		try {
			await queued;
		} finally {
			if (runtimeTransition === queued) runtimeTransition = undefined;
		}
	};
	const canUseRuntime = (context: ExtensionContext, trusted: boolean): boolean =>
		runtimeMatches(runtime, context.cwd, trusted) && runtimeTransition === undefined;
	const getRuntime = async (context: ExtensionContext): Promise<ApplicationRuntime> => {
		const trusted = context.isProjectTrusted?.() === true;
		if (canUseRuntime(context, trusted)) return requireRuntime(runtime);
		await awaitRuntimeTransition(context, trusted);
		return requireRuntime(runtime);
	};

	pi.registerTool({
		name: "khala_submit_work",
		label: "Submit Work",
		description: "Submit complete User intent to the project Conclave without waiting for admission.",
		promptSnippet: "Submit complete User intent for Conclave admission",
		parameters: submitSchema,
		async execute(toolCallId, params: SubmitParams, signal, _onUpdate, context) {
			try {
				throwIfAborted(signal);
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				throwIfAborted(signal);
				const work = service.submitWork(params, meta("user", `tool:submit:${toolCallId}`, 0));
				schedulePendingEffects(service);
				return toolResult(work);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ApplicationError) {
					return toolError(error.envelope);
				}
				return toolErrorText(error instanceof Error ? error.message : "Khala submission failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_read_archive",
		label: "Read Khala Archive",
		description:
			"Read one bounded, scoped decision-evidence packet with current Work facts and selected Archive records.",
		promptSnippet: "Read authoritative Work decision evidence and bounded records before making decisions",
		parameters: readArchiveSchema,
		async execute(toolCallId, params: ReadArchiveParams, signal, _onUpdate, context) {
			try {
				throwIfAborted(signal);
				const actor = sessionRole(pi);
				const query = readArchiveQuery(params, actor);
				const service = (await getRuntime(context)).service;
				throwIfAborted(signal);
				const commandMeta = meta(actor, `tool:archive:${toolCallId}`, 0);
				const page = service.readRecords(query, commandMeta, params.cursor);
				return archiveToolResult(
					createDecisionEvidencePacket({ works: decisionWorks(service, query, page), records: page }),
				);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ApplicationError) {
					return toolError(error.envelope);
				}
				return toolErrorText(error instanceof Error ? error.message : "Archive read failed.");
			}
		},
		renderResult(result, options, theme) {
			return renderArchiveToolResult(result, options.expanded, options.isPartial, theme);
		},
	});

	pi.registerTool({
		name: "khala_poll_provider",
		label: "Poll Provider",
		description: "Poll the current review provider for changed observations and merge evidence.",
		promptSnippet: "Poll the review provider and record observations or merge evidence",
		parameters: Type.Object({
			workId: Type.String({ minLength: 1 }),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, signal, onUpdate, context) {
			try {
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				throwIfAborted(signal);
				const work = await service.pollProvider(
					params.workId,
					meta("user", `tool:poll:${toolCallId}`, params.expectedWorkRevision),
					toolOperation(signal, onUpdate),
				);
				schedulePendingEffects(service);
				return toolResult(work);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ApplicationError) return toolError(error.envelope);
				return toolErrorText(error instanceof Error ? error.message : "Provider polling failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_inspect_runtime",
		label: "Inspect Khala Runtime",
		description: "Inspect bounded Pi runtime liveness without writing the Archive.",
		promptSnippet: "Inspect bound Pi runtime liveness without changing Archive state",
		parameters: inspectRuntimeSchema,
		async execute(toolCallId, params: InspectRuntimeParams, signal, onUpdate, context) {
			try {
				const actor = sessionRole(pi);
				const service = (await getRuntime(context)).service;
				throwIfAborted(signal);
				const work = await service.inspectRuntime(
					params.workId,
					meta(actor, `tool:inspect-runtime:${toolCallId}`, params.expectedWorkRevision),
					toolOperation(signal, onUpdate),
				);
				throwIfAborted(signal);
				return toolResult(work);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ApplicationError) return toolError(error.envelope);
				return toolErrorText(error instanceof Error ? error.message : "Runtime inspection failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_perform_action",
		label: "Perform Khala Action",
		description:
			"Perform one actor-authorized, revision-checked Khala application action. User actions include review, recovery, cancellation, renaming, budget, and failure decisions; Executor and Conclave actions run only in their bound child sessions. Provider comments enter through khala_poll_provider.",
		promptSnippet: "Perform one actor-authorized, revision-checked Khala lifecycle action",
		parameters: performSchema,
		async execute(toolCallId, params: PerformParams, signal, onUpdate, context) {
			return executeActionTool(pi, getRuntime, toolCallId, params, signal, onUpdate, context);
		},
	});

	pi.registerTool({
		name: "khala_record_signal",
		label: "Record Executor Signal",
		description: "Record progress, blocked, or ready evidence for the current Executor Execution.",
		promptSnippet: "Record evidence-bearing Executor progress, blocked, or ready state",
		parameters: Type.Object({
			workId: Type.String({ minLength: 1 }),
			kind: StringEnum(["progress", "blocked", "ready"] as const),
			summary: Type.String({ minLength: 1 }),
			evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, signal, onUpdate, context) {
			try {
				requireSessionRole(pi, "executor");
				const result = await (await getRuntime(context)).service.perform(
					{
						action: "record-signal",
						workId: params.workId,
						input: { kind: params.kind, summary: params.summary, evidence: params.evidence },
						meta: meta("executor", `tool:signal:${toolCallId}`, params.expectedWorkRevision),
					},
					toolOperation(signal, onUpdate),
				);
				if ("error" in result) throw new ApplicationError(result.error);
				return toolResult(result.value);
			} catch (error) {
				throwIfAborted(signal);
				return error instanceof Error
					? toolErrorFromError(error, "Executor signal recording failed.")
					: toolErrorText("Executor signal recording failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_record_assessment",
		label: "Record Observer Assessment",
		description: "Record exactly one bounded, evidence-backed read-only assessment for a Work Submission.",
		promptSnippet: "Record one bounded read-only Observer assessment with evidence",
		parameters: Type.Object({
			workId: Type.String({ minLength: 1 }),
			summary: Type.String({ minLength: 1 }),
			evidence: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, signal, onUpdate, context) {
			try {
				requireSessionRole(pi, "observer");
				const result = await (await getRuntime(context)).service.perform(
					{
						action: "record-assessment",
						workId: params.workId,
						input: { summary: params.summary, evidence: params.evidence },
						meta: meta("observer", `tool:assessment:${toolCallId}`, params.expectedWorkRevision),
					},
					toolOperation(signal, onUpdate),
				);
				if ("error" in result) throw new ApplicationError(result.error);
				return toolResult(result.value);
			} catch (error) {
				throwIfAborted(signal);
				return error instanceof Error
					? toolErrorFromError(error, "Observer assessment recording failed.")
					: toolErrorText("Observer assessment recording failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_run_oracle",
		label: "Run Khala Oracle",
		description: "Ask the no-tools Oracle for advisory findings on a bounded Mission handoff packet.",
		promptSnippet: "Run a bounded advisory Oracle review of the Mission handoff",
		parameters: Type.Object({
			workId: Type.String({ minLength: 1 }),
			subject: Type.String({ minLength: 1 }),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, signal, onUpdate, context) {
			try {
				requireSessionRole(pi, "conclave");
				const result = await (await getRuntime(context)).service.perform(
					{
						action: "run-oracle",
						workId: params.workId,
						input: { subject: params.subject },
						meta: meta("conclave", `tool:oracle:${toolCallId}`, params.expectedWorkRevision),
					},
					toolOperation(signal, onUpdate),
				);
				if ("error" in result) throw new ApplicationError(result.error);
				return toolResult(result.value);
			} catch (error) {
				throwIfAborted(signal);
				return error instanceof Error
					? toolErrorFromError(error, "Oracle review failed.")
					: toolErrorText("Oracle review failed.");
			}
		},
	});

	pi.registerCommand("khala", {
		description: "Open the Khala view.",
		handler: async (_args, context) => {
			try {
				const application = await getRuntime(context);
				await showKhala(application.service, context, sessionRole(pi), application.config.keybindings, {
					get: () => application.service.getRoleSettings(),
					set: (role, setting, value) => {
						persistRoleSetting(role, setting, value);
						application.updateRoleSetting(role, setting, value);
					},
				});
				updateExecutorStatus(application.service, context);
			} catch (error) {
				context.ui.notify(formatCommandError(error instanceof Error ? error : new Error(String(error))), "error");
			}
		},
	});

	pi.registerCommand("khala-recover", {
		description: "Reread Archive state and reconcile Khala runtime bindings.",
		handler: async (_args, context) => {
			try {
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				await service.processPendingEffects();
				const work = service.listWork();
				const report = await recoverUserWork(service, work);
				await service.processPendingEffects();
				updateExecutorStatus(service, context);
				notifyRecoveryComplete(context, report);
			} catch (error) {
				context.ui.notify(formatCommandError(error instanceof Error ? error : new Error(String(error))), "error");
			}
		},
	});

	const initializeUserSession = async (context: ExtensionContext): Promise<void> => {
		try {
			const application = await getRuntime(context);
			schedulePendingEffects(application.service);
			userContext = context;
			updateExecutorStatus(application.service, context);
			executorStatusTimer = setInterval(() => {
				if (runtime?.runtime.service === application.service) updateExecutorStatus(application.service, context);
			}, 5_000);
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	const initializeRoleSession = (context: ExtensionContext): Promise<void> =>
		sessionRole(pi) === "user" ? initializeUserSession(context) : Promise.resolve();
	pi.on("session_start", async (_event, context) => {
		await initializeRoleSession(context);
		setRoleTools(pi);
	});
	pi.on("before_agent_start", (event) => {
		const role = sessionRole(pi);
		if (role === "user") return;
		const promptFile = rolePromptFiles[role];
		if (promptFile === undefined) return;
		const prompt = readFileSync(join(packageRoot, "system-prompts", promptFile), "utf8");
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
	const clearExecutorStatus = (): void => {
		if (executorStatusTimer !== undefined) clearInterval(executorStatusTimer);
		executorStatusTimer = undefined;
		userContext?.ui.setStatus("khala-executors", undefined);
		userContext = undefined;
	};
	const closeApplicationRuntime = async (): Promise<void> => {
		if (runtimeTransition !== undefined) await runtimeTransition.catch(() => undefined);
		const current = runtime;
		runtime = undefined;
		if (current !== undefined) await current.runtime.service.close();
	};
	pi.on("session_shutdown", async () => {
		clearExecutorStatus();
		await closeApplicationRuntime();
	});
}

function runtimeMatches(runtime: RuntimeState | undefined, projectPath: string, trusted: boolean): boolean {
	return runtime !== undefined && runtime.projectPath === projectPath && runtime.trusted === trusted;
}

function requireRuntime(runtime: RuntimeState | undefined): ApplicationRuntime {
	if (runtime === undefined) throw new Error("Khala runtime could not be initialized.");
	return runtime.runtime;
}

function createRuntimeState(
	projectPath: string,
	trusted: boolean,
	modelRegistry: ApplicationModelRegistry,
): RuntimeState {
	return {
		runtime: createApplication(projectPath, trusted, packageRoot, { requireModels: false, modelRegistry }),
		projectPath,
		trusted,
	};
}

function notifyRecoveryComplete(context: ExtensionContext, report: RecoveryReport): void {
	const noun = report.completed === 1 ? "item" : "items";
	const message = `Archive reread and runtime reconciliation completed for ${report.completed} Work ${noun}.`;
	if (report.failures.length === 0) return context.ui.notify(message, "info");
	context.ui.notify(`${message} ${report.failures.length} require attention.`, "warning");
	for (const failure of report.failures) {
		context.ui.notify(`Work ${failure.workId}: ${formatCommandError(failure.error)}`, "error");
	}
}

async function executeActionTool(
	pi: ExtensionAPI,
	getRuntime: (context: ExtensionContext) => Promise<ApplicationRuntime>,
	toolCallId: string,
	params: PerformParams,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<JsonValue> | undefined,
	context: ExtensionContext,
): Promise<ToolResult> {
	try {
		const actor = sessionRole(pi);
		const service = (await getRuntime(context)).service;
		const result = await service.perform(
			{
				action: params.action,
				workId: params.workId,
				input: params.input,
				meta: meta(actor, `tool:action:${toolCallId}`, params.expectedWorkRevision),
			},
			toolOperation(signal, onUpdate),
		);
		return actionToolResult(result, actor, service);
	} catch (error) {
		throwIfAborted(signal);
		const normalized = error instanceof Error ? error : new Error(String(error));
		return actionToolError(normalized);
	}
}

function actionToolResult(
	result: ServiceResult<WorkView>,
	actor: Actor,
	service: ApplicationRuntime["service"],
): ToolResult {
	if ("error" in result) throw new ApplicationError(result.error);
	if (actor === "user") schedulePendingEffects(service);
	return toolResult(result.value);
}

function actionToolError(error: Error): never {
	if (error instanceof ApplicationError) return toolError(error.envelope);
	return toolErrorText(error.message || "Khala action failed.");
}

function schedulePendingEffects(service: ApplicationRuntime["service"]): void {
	queueMicrotask(() => {
		// Effects write durable Archive evidence. Do not retain a tool/session UI
		// context across the asynchronous worker pass; Pi may replace that session.
		void service.processPendingEffects().catch(() => undefined);
	});
}

function updateExecutorStatus(service: ApplicationRuntime["service"], context: ExtensionContext): void {
	const running = service
		.listWork()
		.filter((item) => item.state === "active" && item.executionState === "running").length;
	const status = running === 0 ? "khala: idle" : `khala: ◈ ${running}`;
	context.ui.setStatus("khala-executors", context.ui.theme.fg("dim", status));
}

function readArchiveQuery(params: ReadArchiveParams, actor: Actor): MutableRecordQuery {
	const scopedWorkId = boundWorkId(actor);
	assertArchiveWorkScope(params.workId, scopedWorkId);
	return {
		order: "desc",
		workId: scopedWorkId ?? params.workId,
		missionId: params.missionId,
		executionId: params.executionId,
		kinds: params.kinds === undefined ? undefined : readRecordKinds(params.kinds),
		states: params.states,
		from: params.from,
		to: params.to,
	};
}

function assertArchiveWorkScope(workId: string | undefined, bound: string | undefined): void {
	if (bound === undefined) return;
	if (workId === undefined) return;
	if (workId === bound) return;
	throw new ApplicationError({
		code: "forbidden",
		summary: "A bound role may only read its assigned Work.",
		retryable: false,
		remediation: "Omit workId or use the Work ID from the role binding.",
		evidenceRefs: [],
	});
}

function boundWorkId(actor: Actor): string | undefined {
	return actor === "observer" || actor === "executor" ? process.env["KHALA_BOUND_WORK_ID"] : undefined;
}

function decisionWorks(
	service: ApplicationRuntime["service"],
	query: MutableRecordQuery,
	page: Readonly<{ items: readonly Readonly<{ workId: string }>[] }>,
): readonly WorkView[] {
	const workIds = [
		...new Set([...(query.workId === undefined ? [] : [query.workId]), ...page.items.map((record) => record.workId)]),
	];
	return workIds.flatMap((workId) => {
		try {
			return [service.inspectWork(workId)];
		} catch (error) {
			if (error instanceof ApplicationError && error.envelope.code === "not-found") return [];
			throw error;
		}
	});
}
function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	try {
		return values.map(parseRecordKind);
	} catch (error) {
		throw new ApplicationError({
			code: "invalid-input",
			summary: error instanceof Error ? error.message : "Archive record kind is invalid.",
			retryable: false,
			remediation: "Use one of the supported Archive record kinds.",
			evidenceRefs: [],
		});
	}
}

export { SQLiteArchive } from "./archive.js";
export type { KhalaArchiveView } from "./archive-view.js";
export { openKhalaArchive } from "./archive-view.js";
export { summarizeArchiveToolValue, summarizeToolError } from "./extension-results.js";
export type { ApplicationRuntime } from "./factory.js";
export { createApplication } from "./factory.js";
export type {
	Action,
	ActionCommand,
	CommandMeta,
	ErrorEnvelope,
	Execution,
	GovernedRole,
	Mission,
	RecordSummaryView,
	RecordView,
	RoleSetting,
	RoleSettings,
	RoleSettingsMap,
	SubmitWorkInput,
	ValidationResult,
	ValidationRun,
	WorkSummary,
	WorkView,
} from "./model.js";
export { ApplicationError, ApplicationService } from "./service.js";
export { showKhalaArchive } from "./tui.js";
