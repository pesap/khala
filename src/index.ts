import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { persistRoleSetting } from "./config.js";
import { type ApplicationModelRegistry, type ApplicationRuntime, createApplication } from "./factory.js";
import {
	type Actor,
	type CommandMeta,
	type JsonObject,
	type JsonValue,
	type MutableRecordQuery,
	parseRecordKind,
	RECORD_KINDS,
	type RecordKind,
	type ServiceResult,
	WORK_STATES,
	type WorkView,
} from "./model.js";
import type { OperationContext } from "./ports.js";
import { ApplicationError } from "./service.js";
import { showKhala } from "./tui.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ROLE_FLAG = "khala-role";
type SessionRole = "user" | "conclave" | "observer" | "executor" | "oracle";
type RestrictedSessionRole = Exclude<SessionRole, "user">;
const RESTRICTED_ROLE_TOOLS = {
	conclave: new Set(["khala_read_archive", "khala_perform_action", "khala_run_oracle", "khala_inspect_runtime"]),
	executor: new Set([
		"read",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"khala_read_archive",
		"khala_record_signal",
		"khala_perform_action",
	]),
	observer: new Set(["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"]),
	oracle: new Set(),
} satisfies Record<RestrictedSessionRole, ReadonlySet<string>>;
const rolePromptFiles = {
	conclave: "conclave.md",
	observer: "observer.md",
	executor: "executor.md",
	oracle: "oracle.md",
} as const;
const roleToken = readRoleToken();
const SESSION_ROLES = new Map<string, "conclave" | "observer" | "executor" | "oracle">([
	["conclave", "conclave"],
	["observer", "observer"],
	["executor", "executor"],
	["oracle", "oracle"],
]);

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
	executionId: Type.Optional(Type.String({ minLength: 1 })),
	kinds: Type.Optional(Type.Array(StringEnum(RECORD_KINDS))),
	states: Type.Optional(Type.Array(StringEnum(WORK_STATES))),
	from: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String({ minLength: 1 })),
});
type ReadArchiveParams = Static<typeof readArchiveSchema>;

const inspectRuntimeSchema = Type.Object({
	workId: Type.String({ minLength: 1 }),
	expectedWorkRevision: Type.Integer({ minimum: 0 }),
});
type InspectRuntimeParams = Static<typeof inspectRuntimeSchema>;

const actionInputSchema = Type.Object({
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
		"fail-work",
	] as const),
	workId: Type.String({ minLength: 1 }),
	input: Type.Optional(actionInputSchema),
	expectedWorkRevision: Type.Integer({ minimum: 0 }),
});
type PerformParams = Static<typeof performSchema>;

type RuntimeState = Readonly<{ runtime: ApplicationRuntime; projectPath: string; trusted: boolean }>;
type ToolResult = { content: [{ type: "text"; text: string }]; details: JsonValue };

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
		description: "Read bounded, append-ordered Archive record projections through the application service.",
		promptSnippet: "Read authoritative bounded Archive records before making decisions",
		parameters: readArchiveSchema,
		async execute(toolCallId, params: ReadArchiveParams, signal, _onUpdate, context) {
			try {
				throwIfAborted(signal);
				const actor = sessionRole(pi);
				const query = readArchiveQuery(params, actor);
				const service = (await getRuntime(context)).service;
				throwIfAborted(signal);
				const page = service.readRecords(query, meta(actor, `tool:archive:${toolCallId}`, 0), params.cursor);
				const projects = archiveWorkIds(query, page).flatMap((workId) => {
					try {
						return [service.inspectWork(workId)];
					} catch (error) {
						if (error instanceof ApplicationError && error.envelope.code === "not-found") return [];
						throw error;
					}
				});
				return archiveToolResult(page, projects);
			} catch (error) {
				throwIfAborted(signal);
				if (error instanceof ApplicationError) {
					return toolError(error.envelope);
				}
				return toolErrorText(error instanceof Error ? error.message : "Archive read failed.");
			}
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
				await recoverUserWork(service, work);
				await service.processPendingEffects();
				updateExecutorStatus(service, context);
				notifyRecoveryComplete(context, work.length);
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

async function recoverUserWork(
	service: ApplicationRuntime["service"],
	work: readonly ReturnType<ApplicationRuntime["service"]["listWork"]>[number][],
): Promise<void> {
	for (const item of work) {
		const current = service.inspectWork(item.workId);
		await service.recoverWork(
			item.workId,
			meta("user", `recover:${item.workId}:${current.revision}`, current.revision),
		);
	}
}

function notifyRecoveryComplete(context: ExtensionContext, workCount: number): void {
	const noun = workCount === 1 ? "item" : "items";
	context.ui.notify(`Archive reread and runtime reconciliation completed for ${workCount} Work ${noun}.`, "info");
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

function sessionRole(pi: ExtensionAPI): SessionRole {
	const value = pi.getFlag(ROLE_FLAG);
	return isSessionRole(value) ? value : "user";
}

function restrictedToolViolation(pi: ExtensionAPI, event: ToolCallEvent): string | undefined {
	const role = sessionRole(pi);
	const allowed = roleToolNames(role);
	if (allowed === undefined) return;
	if (!allowed.has(event.toolName)) return `The ${role} session cannot use the ${event.toolName} tool.`;
	return restrictedPathViolation(role, event);
}

function restrictedPathViolation(role: SessionRole, event: ToolCallEvent): string | undefined {
	return role === "executor" || role === "observer" ? executorToolViolation(event) : undefined;
}

function isSessionRole(value: string | boolean | undefined): value is "conclave" | "observer" | "executor" | "oracle" {
	return value !== undefined && SESSION_ROLES.get(String(value)) === value;
}

function requireSessionRole(pi: ExtensionAPI, expected: Exclude<Actor, "monitor" | "system">): void {
	const actual = sessionRole(pi);
	if (actual !== expected)
		throw new ApplicationError({
			code: "forbidden",
			summary: `The ${expected} tool requires a ${expected} session.`,
			retryable: false,
			remediation: "Use the tool from its bound Khala role session.",
			evidenceRefs: [],
		});
}

function setRoleTools(pi: ExtensionAPI): void {
	const allowed = roleToolNames(sessionRole(pi));
	if (allowed === undefined) return;
	pi.setActiveTools(pi.getActiveTools().filter((name) => allowed.has(name)));
}

function roleToolNames(role: SessionRole): ReadonlySet<string> | undefined {
	return role === "user" ? undefined : RESTRICTED_ROLE_TOOLS[role];
}

function executorToolViolation(event: ToolCallEvent): string | undefined {
	const path = executorToolPath(event);
	if (path === null) return `The ${event.toolName} tool requires a path.`;
	return path === undefined ? undefined : pathViolation(path, event.toolName === "write" || event.toolName === "edit");
}

function pathViolation(path: string, write: boolean): string | undefined {
	if (!executorPathInsideSandbox(path)) return `The Mission does not permit access to ${path}.`;
	if (write && !executorPathAllowed(path)) return `The Mission does not permit writes to ${path}.`;
	return;
}

function executorToolPath(event: ToolCallEvent): string | null | undefined {
	const filePath = fileToolPath(event);
	return filePath === undefined ? searchToolPath(event) : filePath;
}

type FileToolCallEvent = Extract<ToolCallEvent, { toolName: "read" | "write" | "edit" }>;

function fileToolPath(event: ToolCallEvent): string | null | undefined {
	if (!isFileTool(event)) return;
	// SAFETY: Pi's file tool schemas supply a path string; the assertion narrows the external tool event at this boundary.
	return textValue(event.input.path as JsonValue) ?? null;
}

function isFileTool(event: ToolCallEvent): event is FileToolCallEvent {
	return ["read", "write", "edit"].includes(event.toolName);
}

type SearchToolCallEvent = Extract<ToolCallEvent, { toolName: "grep" | "find" | "ls" }>;

function searchToolPath(event: ToolCallEvent): string | undefined {
	if (!isSearchTool(event)) return;
	// SAFETY: Pi's search/list schemas supply an optional path string; the assertion narrows the external tool event at this boundary.
	return textValue(event.input.path as JsonValue) ?? ".";
}

function isSearchTool(event: ToolCallEvent): event is SearchToolCallEvent {
	return event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls";
}

function textValue(value: JsonValue | undefined): string | undefined {
	return value === String(value) ? String(value) : undefined;
}

function executorPathInsideSandbox(path: string): boolean {
	const scope = executorPathScope();
	return scope === null ? false : pathInsideRoot(path, scope.root);
}

function executorPathAllowed(path: string): boolean {
	const scope = executorPathScope();
	return scope === null ? false : pathMatchesScope(path, scope);
}

function pathMatchesScope(path: string, scope: Readonly<{ root: string; allowedPaths: readonly string[] }>): boolean {
	const rootRelative = relativeToRoot(path, scope.root);
	return rootRelative !== undefined && scope.allowedPaths.some((allowed) => matchesAllowedPath(rootRelative, allowed));
}

function pathInsideRoot(path: string, root: string): boolean {
	return relativeToRoot(path, root) !== undefined;
}

function relativeToRoot(path: string, root: string): string | undefined {
	const resolvedRoot = realPath(root);
	const candidate = resolveExistingPath(resolveExecutorPath(root, path));
	if (resolvedRoot === undefined || candidate === undefined) return;
	const rootRelative = relative(resolvedRoot, candidate).replace(/\\/g, "/");
	return isInsideRoot(rootRelative) ? rootRelative : undefined;
}

function resolveExistingPath(path: string): string | undefined {
	let current = path;
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return;
		suffix.unshift(current.slice(parent.length + 1));
		current = parent;
	}
	const resolved = realPath(current);
	return resolved === undefined ? undefined : resolve(resolved, ...suffix);
}

function realPath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function executorPathScope(): Readonly<{ root: string; allowedPaths: readonly string[] }> | null {
	const root = process.env["KHALA_SANDBOX_ROOT"];
	const encodedPaths = process.env["KHALA_ALLOWED_PATHS"];
	if (root === undefined) return null;
	if (encodedPaths === undefined) return null;
	const allowedPaths = parseAllowedPaths(encodedPaths);
	return allowedPaths === undefined ? null : { root, allowedPaths };
}

function resolveExecutorPath(root: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function parseAllowedPaths(encoded: string): readonly string[] | undefined {
	try {
		// SAFETY: isTextValue verifies every JSON array member before narrowing it to a string.
		const parsed = JSON.parse(encoded) as JsonValue;
		return Array.isArray(parsed) && parsed.every(isTextValue) ? parsed.filter(isTextValue) : undefined;
	} catch {
		return undefined;
	}
}

function isInsideRoot(rootRelative: string): boolean {
	return !rootRelative.startsWith("..") && !isAbsolute(rootRelative);
}

function matchesAllowedPath(rootRelative: string, allowed: string): boolean {
	const normalized = allowed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	return normalized === "." || rootRelative === normalized || rootRelative.startsWith(`${normalized}/`);
}

function readRoleToken(): string | undefined {
	const path = process.env["KHALA_ROLE_TOKEN_FILE"];
	if (path === undefined) return;
	try {
		const token = readFileSync(path, "utf8").trim();
		removeRoleTokenFile(path);
		return token.length === 0 ? undefined : token;
	} catch {
		return;
	}
}

function removeRoleTokenFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// The runtime removes the capability file during child startup cleanup.
	}
}

function meta(actor: Actor, commandId: string, expectedWorkRevision: number): CommandMeta {
	return {
		actor,
		commandId,
		expectedWorkRevision,
		roleToken: actor === "user" ? undefined : roleToken,
		roleNonce: actor === "user" ? undefined : process.env["KHALA_ROLE_NONCE"],
		boundWorkId: process.env["KHALA_BOUND_WORK_ID"],
		boundExecutionId: process.env["KHALA_BOUND_EXECUTION_ID"],
		schemaVersion: 1,
	};
}

function readArchiveQuery(params: ReadArchiveParams, actor: Actor): MutableRecordQuery {
	const scopedWorkId = boundWorkId(actor);
	assertArchiveWorkScope(params.workId, scopedWorkId);
	return {
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

function toolResult(value: JsonValue): ToolResult {
	return {
		content: [{ type: "text", text: boundedToolText(summarizeToolValue(value), value) }],
		details: value,
	};
}

function archiveToolResult(value: JsonValue, projects: readonly WorkView[]): ToolResult {
	return {
		content: [{ type: "text", text: boundedToolText(summarizeArchiveToolValue(value, projects), value) }],
		details: value,
	};
}

// Pi marks an execute() failure only when the tool throws; an isError field on a returned value is ignored.
function toolError(error: JsonObject): never {
	throw new Error(boundedToolText(summarizeToolError(error), error));
}

function toolOperation(
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<JsonValue> | undefined,
): OperationContext {
	return {
		signal,
		onUpdate:
			onUpdate === undefined
				? undefined
				: (message) =>
						onUpdate({
							content: [{ type: "text", text: message }],
							details: { progress: message },
						}),
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("Khala operation was cancelled.");
}
function boundedToolText(text: string, value: JsonValue): string {
	const truncated = truncateHead(text, { maxBytes: 48_000, maxLines: 1_800 });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n[Output truncated. ${continuationHint(value)}]`;
}

function continuationHint(value: JsonValue): string {
	const cursor = isJsonObject(value) && isTextValue(value["nextCursor"]) ? value["nextCursor"] : undefined;
	return cursor === undefined
		? "Use narrower filters or a targeted query to retrieve the remainder."
		: `Use nextCursor ${cursor} to continue.`;
}

function formatCommandError(error: Error): string {
	if (!(error instanceof ApplicationError)) return error.message;
	const envelope = error.envelope;
	const evidence = envelope.evidenceRefs.length === 0 ? "" : `\nEvidence: ${envelope.evidenceRefs.join(", ")}`;
	return `Code: ${envelope.code}\n${envelope.summary}\nNext: ${envelope.remediation}${evidence}`;
}

function toolErrorText(message: string): never {
	return toolError({
		code: "external-failure",
		summary: message,
		retryable: true,
		remediation: "Inspect the error and retry the operation when the underlying failure is resolved.",
		evidenceRefs: [],
	});
}

function toolErrorFromError(error: Error, fallback: string): never {
	return error instanceof ApplicationError ? toolError(error.envelope) : toolErrorText(error.message || fallback);
}
function summarizeToolValue(value: JsonValue): string {
	const workSummary = summarizeWorkValue(value);
	if (workSummary !== undefined) return workSummary;
	const archiveSummary = summarizeArchiveValue(value);
	return archiveSummary ?? prettyJson(value);
}

function summarizeWorkValue(value: JsonValue): string | undefined {
	if (!isWorkSummary(value)) return undefined;
	return [
		`Work: ${value["workId"]}`,
		`State: ${value["state"]}`,
		`Next action: ${presentToolText(String(value["nextAction"]))}`,
		`Revision: ${value["revision"] ?? "unknown"}`,
	].join("\n");
}

function summarizeArchiveValue(value: JsonValue): string | undefined {
	return isArchiveSummary(value) ? summarizeArchiveToolValue(value, []) : undefined;
}

export function summarizeArchiveToolValue(value: JsonValue, projects: readonly WorkView[]): string {
	if (!isArchiveSummary(value)) return prettyJson(value);
	const records = value["items"].filter(isJsonObject).map(archiveRecordSummary);
	const nextCursor = archiveNextCursor(value);
	return [
		...projects.map(archiveWorkProjection),
		`Archive records: ${records.length}`,
		`As of sequence: ${value["asOfSequence"]}`,
		...(nextCursor === undefined ? [] : [nextCursor]),
		...records,
	].join("\n");
}

function archiveWorkIds(query: MutableRecordQuery, page: JsonObject): readonly string[] {
	const records = Array.isArray(page["items"])
		? page["items"].filter(isJsonObject).map((record) => record["workId"])
		: [];
	const ids = [...(query.workId === undefined ? [] : [query.workId]), ...records.filter(isTextValue)];
	return [...new Set(ids)];
}

function archiveWorkProjection(work: WorkView): string {
	return [
		`Work ${work.workId}: revision ${work.revision}; state ${work.state}`,
		...archiveMissionState(work),
		...archiveMissionIdentity(work),
		...archiveTermsProjection("Terms", work.mission?.assignment ?? work.terms),
	].join("\n");
}

function archiveMissionState(work: WorkView): readonly string[] {
	return work.missionState === undefined ? [] : [`Mission state: ${work.missionState}`];
}

function archiveMissionIdentity(work: WorkView): readonly string[] {
	const mission = work.mission;
	return mission === undefined ? [] : [`Mission ${mission.missionId}: mandate revision ${mission.mandateRevision}`];
}

function archiveTermsProjection(label: string, terms: WorkView["terms"]): readonly string[] {
	return [
		`${label} title: ${boundedProjectionText(terms.title)}`,
		`${label} objective: ${boundedProjectionText(terms.objective)}`,
		`${label} scope: ${boundedProjectionText(terms.scope)}`,
		`${label} acceptance criteria: ${boundedProjectionList(terms.acceptanceCriteria)}`,
		`${label} constraints: ${boundedProjectionList(terms.constraints)}`,
		`${label} validation: ${boundedProjectionList(terms.validation)}`,
		`${label} allowed paths: ${boundedProjectionList(terms.allowedPaths)}`,
	];
}

function boundedProjectionText(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function boundedProjectionList(values: readonly string[]): string {
	return values.slice(0, 20).map(boundedProjectionText).join(" | ").slice(0, 4_000) || "(none)";
}

function isWorkSummary(value: JsonValue): value is JsonObject {
	if (!isJsonObject(value)) return false;
	return ["workId", "state", "nextAction"].every((key) => isTextValue(value[key]));
}

function isArchiveSummary(
	value: JsonValue,
): value is JsonObject & { items: readonly JsonObject[]; asOfSequence: number } {
	if (!isJsonObject(value)) return false;
	return Array.isArray(value["items"]) && isIntegerValue(value["asOfSequence"]);
}

function archiveRecordSummary(record: JsonObject): string {
	const sequence = archiveSequence(record);
	const kind = archiveKind(record);
	const summary = archiveSummary(record);
	return `${sequence}${kind}${summary.length === 0 ? "" : `: ${summary}`}`;
}

function archiveSequence(record: JsonObject): string {
	return isIntegerValue(record["sequence"]) ? `#${record["sequence"]} ` : "";
}

function archiveKind(record: JsonObject): string {
	return isTextValue(record["kind"]) ? record["kind"] : "record";
}

function archiveSummary(record: JsonObject): string {
	return isTextValue(record["summary"]) ? record["summary"] : "";
}

function archiveNextCursor(value: JsonObject): string | undefined {
	if (!isTextValue(value["nextCursor"]) || value["nextCursor"].length === 0) return undefined;
	return `Next cursor: ${value["nextCursor"]}`;
}
export function summarizeToolError(error: JsonObject): string {
	return [errorSummary(error), errorRemediation(error), errorEvidence(error)].filter(isTextValue).join("\n");
}

function errorSummary(error: JsonObject): string {
	return isTextValue(error["summary"]) ? `Error: ${presentToolText(error["summary"])}` : "Khala action failed.";
}

function errorRemediation(error: JsonObject): string | undefined {
	return isTextValue(error["remediation"]) ? `Next step: ${presentToolText(error["remediation"])}` : undefined;
}

function errorEvidence(error: JsonObject): string | undefined {
	const refs = error["evidenceRefs"];
	if (!Array.isArray(refs) || refs.length === 0) return undefined;
	return `Evidence: ${refs.filter(isTextValue).join(", ")}`;
}

function presentToolText(value: string): string {
	return value
		.split(";")
		.map((part, index) => {
			const text = part.trim();
			return index === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
		})
		.filter((part) => part.length > 0)
		.join(". ");
}

function prettyJson(value: JsonValue): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function isIntegerValue(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}

export { SQLiteArchive } from "./archive.js";
export type { KhalaArchiveView } from "./archive-view.js";
export { openKhalaArchive } from "./archive-view.js";
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
