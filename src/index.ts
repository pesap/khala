import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { persistRoleSetting } from "./config.js";
import { type ApplicationRuntime, createApplication } from "./factory.js";
import {
	type Actor,
	type CommandMeta,
	type JsonObject,
	type JsonValue,
	type MutableRecordQuery,
	parseRecordKind,
	type RecordKind,
} from "./model.js";
import { ApplicationError } from "./service.js";
import { showKhala } from "./tui.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ROLE_FLAG = "khala-role";
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
	title: Type.String(),
	objective: Type.String(),
	context: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String()),
	acceptanceCriteria: Type.Array(Type.String()),
	constraints: Type.Optional(Type.Array(Type.String())),
	validation: Type.Optional(Type.Array(Type.String())),
	allowedPaths: Type.Optional(Type.Array(Type.String())),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
type SubmitParams = Static<typeof submitSchema>;

const readArchiveSchema = Type.Object({
	workId: Type.Optional(Type.String()),
	missionId: Type.Optional(Type.String()),
	executionId: Type.Optional(Type.String()),
	kinds: Type.Optional(Type.Array(Type.String())),
	states: Type.Optional(Type.Array(Type.String())),
	from: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String()),
});
type ReadArchiveParams = Static<typeof readArchiveSchema>;

const inspectRuntimeSchema = Type.Object({ workId: Type.String(), expectedWorkRevision: Type.Integer({ minimum: 0 }) });
type InspectRuntimeParams = Static<typeof inspectRuntimeSchema>;

const actionInputSchema = Type.Object({
	kind: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.Array(Type.String())),
	decision: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	signalId: Type.Optional(Type.String()),
	status: Type.Optional(Type.String()),
	feedback: Type.Optional(Type.Array(Type.String())),
	title: Type.Optional(Type.String()),
	objective: Type.Optional(Type.String()),
	context: Type.Optional(Type.String()),
	scope: Type.Optional(Type.String()),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
	constraints: Type.Optional(Type.Array(Type.String())),
	validation: Type.Optional(Type.Array(Type.String())),
	allowedPaths: Type.Optional(Type.Array(Type.String())),
	missing: Type.Optional(Type.Array(Type.String())),
	observationId: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
const performSchema = Type.Object({
	action: Type.Union([
		Type.Literal("admit"),
		Type.Literal("request-input"),
		Type.Literal("amend-terms"),
		Type.Literal("amend-mission"),
		Type.Literal("launch-observer"),
		Type.Literal("record-assessment"),
		Type.Literal("start-execution"),
		Type.Literal("record-signal"),
		Type.Literal("commit-sandbox"),
		Type.Literal("run-validation"),
		Type.Literal("create-review-request"),
		Type.Literal("run-oracle"),
		Type.Literal("verdict"),
		Type.Literal("deliver-feedback"),
		Type.Literal("record-review"),
		Type.Literal("record-outcome"),
		Type.Literal("cancel"),
		Type.Literal("recover"),
		Type.Literal("rename-work"),
		Type.Literal("amend-budget"),
		Type.Literal("fail-work"),
	]),
	workId: Type.String(),
	input: Type.Optional(actionInputSchema),
	expectedWorkRevision: Type.Integer({ minimum: 0 }),
});
type PerformParams = Static<typeof performSchema>;

type RuntimeState = Readonly<{ runtime: ApplicationRuntime; projectPath: string; trusted: boolean }>;
type ToolResult = { content: [{ type: "text"; text: string }]; details: JsonValue; isError: boolean };
type ToolErrorResult = { content: [{ type: "text"; text: string }]; details: JsonObject; isError: true };

export default function khalaExtension(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_FLAG, { description: "Khala role for an isolated child session", type: "string" });
	pi.on("tool_call", (event) => {
		const role = sessionRole(pi);
		if (role !== "executor" && role !== "observer") return;
		const violation = executorToolViolation(event);
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
		runtime = createRuntimeState(context.cwd, trusted);
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
		const trusted = isTrustedProject(context);
		if (canUseRuntime(context, trusted)) return requireRuntime(runtime);
		await awaitRuntimeTransition(context, trusted);
		return requireRuntime(runtime);
	};

	pi.registerTool({
		name: "khala_submit_work",
		label: "Submit Work",
		description: "Submit complete User intent to the project Conclave without waiting for admission.",
		parameters: submitSchema,
		async execute(toolCallId, params: SubmitParams, _signal, _onUpdate, context) {
			try {
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				const work = service.submitWork(params, meta("user", `tool:submit:${toolCallId}`, 0));
				schedulePendingEffects(service);
				return toolResult(work, false);
			} catch (error) {
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
		parameters: readArchiveSchema,
		async execute(toolCallId, params: ReadArchiveParams, _signal, _onUpdate, context) {
			try {
				const actor = sessionActor(pi);
				const query = readArchiveQuery(params, actor);
				const page = (await getRuntime(context)).service.readRecords(
					query,
					meta(actor, `tool:archive:${toolCallId}`, 0),
					params.cursor,
				);
				return toolResult(page, false);
			} catch (error) {
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
		parameters: Type.Object({ workId: Type.String(), expectedWorkRevision: Type.Integer({ minimum: 0 }) }),
		async execute(toolCallId, params, _signal, _onUpdate, context) {
			try {
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				const work = await service.pollProvider(
					params.workId,
					meta("user", `tool:poll:${toolCallId}`, params.expectedWorkRevision),
				);
				schedulePendingEffects(service);
				return toolResult(work, false);
			} catch (error) {
				if (error instanceof ApplicationError) return toolError(error.envelope);
				return toolErrorText(error instanceof Error ? error.message : "Provider polling failed.");
			}
		},
	});

	pi.registerTool({
		name: "khala_inspect_runtime",
		label: "Inspect Khala Runtime",
		description: "Inspect bounded Pi runtime liveness without writing the Archive.",
		parameters: inspectRuntimeSchema,
		async execute(toolCallId, params: InspectRuntimeParams, _signal, _onUpdate, context) {
			try {
				const actor = sessionActor(pi);
				const work = await (await getRuntime(context)).service.inspectRuntime(
					params.workId,
					meta(actor, `tool:inspect-runtime:${toolCallId}`, params.expectedWorkRevision),
				);
				return toolResult(work, false);
			} catch (error) {
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
		parameters: performSchema,
		async execute(toolCallId, params: PerformParams, _signal, _onUpdate, context) {
			return executeActionTool(pi, getRuntime, toolCallId, params, context);
		},
	});

	pi.registerTool({
		name: "khala_record_signal",
		label: "Record Executor Signal",
		description: "Record progress, blocked, or ready evidence for the current Executor Execution.",
		parameters: Type.Object({
			workId: Type.String(),
			kind: Type.Union([Type.Literal("progress"), Type.Literal("blocked"), Type.Literal("ready")]),
			summary: Type.String(),
			evidence: Type.Array(Type.String()),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, context) {
			try {
				requireSessionRole(pi, "executor");
				const result = await (await getRuntime(context)).service.perform({
					action: "record-signal",
					workId: params.workId,
					input: { kind: params.kind, summary: params.summary, evidence: params.evidence },
					meta: meta("executor", `tool:signal:${toolCallId}`, params.expectedWorkRevision),
				});
				return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
			} catch (error) {
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
		parameters: Type.Object({
			workId: Type.String(),
			summary: Type.String(),
			evidence: Type.Array(Type.String()),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, context) {
			try {
				requireSessionRole(pi, "observer");
				const result = await (await getRuntime(context)).service.perform({
					action: "record-assessment",
					workId: params.workId,
					input: { summary: params.summary, evidence: params.evidence },
					meta: meta("observer", `tool:assessment:${toolCallId}`, params.expectedWorkRevision),
				});
				return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
			} catch (error) {
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
		parameters: Type.Object({
			workId: Type.String(),
			subject: Type.String(),
			expectedWorkRevision: Type.Integer({ minimum: 0 }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, context) {
			try {
				requireSessionRole(pi, "conclave");
				const result = await (await getRuntime(context)).service.perform({
					action: "run-oracle",
					workId: params.workId,
					input: { subject: params.subject },
					meta: meta("conclave", `tool:oracle:${toolCallId}`, params.expectedWorkRevision),
				});
				return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
			} catch (error) {
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
				await showKhala(application.service, context, sessionActor(pi), application.config.keybindings, {
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
		// oxlint-disable-next-line complexity
		handler: async (_args, context) => {
			try {
				requireSessionRole(pi, "user");
				const service = (await getRuntime(context)).service;
				await service.processPendingEffects();
				const work = service.listWork();
				for (const item of work) {
					const current = service.inspectWork(item.workId);
					await service.recoverWork(
						item.workId,
						meta("user", `recover:${item.workId}:${current.revision}`, current.revision),
					);
				}
				updateExecutorStatus(service, context);
				context.ui.notify(
					`Archive reread and runtime reconciliation completed for ${work.length} Work item${work.length === 1 ? "" : "s"}.`,
					"info",
				);
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

function isTrustedProject(context: ExtensionContext): boolean {
	return context.isProjectTrusted?.() === true;
}

function requireRuntime(runtime: RuntimeState | undefined): ApplicationRuntime {
	if (runtime === undefined) throw new Error("Khala runtime could not be initialized.");
	return runtime.runtime;
}

function createRuntimeState(projectPath: string, trusted: boolean): RuntimeState {
	return {
		runtime: createApplication(projectPath, trusted, packageRoot, { requireModels: false }),
		projectPath,
		trusted,
	};
}

// oxlint-disable-next-line complexity
async function executeActionTool(
	pi: ExtensionAPI,
	getRuntime: (context: ExtensionContext) => Promise<ApplicationRuntime>,
	toolCallId: string,
	params: PerformParams,
	context: ExtensionContext,
): Promise<ToolResult | ToolErrorResult> {
	try {
		const actor = sessionActor(pi);
		const service = (await getRuntime(context)).service;
		const result = await service.perform({
			action: params.action,
			workId: params.workId,
			input: params.input,
			meta: meta(actor, `tool:action:${toolCallId}`, params.expectedWorkRevision),
		});
		if (!("error" in result) && actor === "user") schedulePendingEffects(service);
		return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
	} catch (error) {
		return error instanceof ApplicationError
			? toolError(error.envelope)
			: toolErrorText(error instanceof Error ? error.message : "Khala action failed.");
	}
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

function sessionRole(pi: ExtensionAPI): "user" | "conclave" | "observer" | "executor" | "oracle" {
	const value = pi.getFlag(ROLE_FLAG);
	return isSessionRole(value) ? value : "user";
}

function isSessionRole(value: string | boolean | undefined): value is "conclave" | "observer" | "executor" | "oracle" {
	return value !== undefined && SESSION_ROLES.get(String(value)) === value;
}

function sessionActor(pi: ExtensionAPI): Actor {
	return sessionRole(pi);
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
	const allowed = roleTools(sessionRole(pi));
	pi.setActiveTools(pi.getActiveTools().filter((name) => !name.startsWith("khala_") || allowed.has(name)));
}

function roleTools(role: ReturnType<typeof sessionRole>): ReadonlySet<string> {
	const tools = {
		user: [
			"khala_submit_work",
			"khala_read_archive",
			"khala_perform_action",
			"khala_poll_provider",
			"khala_inspect_runtime",
		],
		conclave: ["khala_read_archive", "khala_perform_action", "khala_run_oracle", "khala_inspect_runtime"],
		executor: ["khala_read_archive", "khala_record_signal", "khala_perform_action"],
		observer: ["khala_read_archive", "khala_record_assessment"],
		oracle: ["khala_read_archive"],
	} satisfies Record<ReturnType<typeof sessionRole>, readonly string[]>;
	return new Set(tools[role]);
}

function executorToolViolation(event: ToolCallEvent): string | undefined {
	const path = executorToolPath(event);
	if (path === null) return `The ${event.toolName} tool requires a path.`;
	return path === undefined ? undefined : pathViolation(path, isWriteTool(event.toolName));
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

function isWriteTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
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
		unlinkSync(path);
		return token.length === 0 ? undefined : token;
	} catch {
		return;
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
	return {
		workId: params.workId ?? boundWorkId(actor),
		missionId: params.missionId,
		executionId: params.executionId,
		kinds: params.kinds === undefined ? undefined : readRecordKinds(params.kinds),
		states: params.states,
		from: params.from,
		to: params.to,
	};
}

function boundWorkId(actor: Actor): string | undefined {
	return actor === "observer" || actor === "executor" ? process.env["KHALA_BOUND_WORK_ID"] : undefined;
}

function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	return values.map(parseRecordKind);
}

function toolResult(value: JsonValue, isError: boolean): ToolResult {
	return { content: [{ type: "text", text: summarizeToolValue(value) }], details: value, isError };
}

function toolError(error: JsonObject): ToolErrorResult {
	return { content: [{ type: "text", text: summarizeToolError(error) }], details: error, isError: true };
}

function formatCommandError(error: Error): string {
	if (!(error instanceof ApplicationError)) return error.message;
	const envelope = error.envelope;
	const evidence = envelope.evidenceRefs.length === 0 ? "" : `\nEvidence: ${envelope.evidenceRefs.join(", ")}`;
	return `Code: ${envelope.code}\n${envelope.summary}\nNext: ${envelope.remediation}${evidence}`;
}

function toolErrorText(message: string): ToolErrorResult {
	return toolError({
		code: "external-failure",
		summary: message,
		retryable: true,
		remediation: "Inspect the error and retry the operation when the underlying failure is resolved.",
		evidenceRefs: [],
	});
}

function toolErrorFromError(error: Error, fallback: string): ToolErrorResult {
	return error instanceof ApplicationError ? toolError(error.envelope) : toolErrorText(error.message || fallback);
}

// oxlint-disable-next-line complexity
function summarizeToolValue(value: JsonValue): string {
	if (
		isJsonObject(value) &&
		isTextValue(value["workId"]) &&
		isTextValue(value["state"]) &&
		isTextValue(value["nextAction"])
	) {
		return [
			`Work: ${value["workId"]}`,
			`State: ${value["state"]}`,
			`Next action: ${presentToolText(String(value["nextAction"]))}`,
			`Revision: ${value["revision"] ?? "unknown"}`,
		].join("\n");
	}
	if (isJsonObject(value) && Array.isArray(value["items"]) && isIntegerValue(value["asOfSequence"])) {
		// oxlint-disable-next-line complexity
		const records = value["items"].filter(isJsonObject).map((record) => {
			const sequence = isIntegerValue(record["sequence"]) ? `#${record["sequence"]} ` : "";
			const kind = isTextValue(record["kind"]) ? record["kind"] : "record";
			const summary = isTextValue(record["summary"]) ? record["summary"] : "";
			return `${sequence}${kind}${summary.length === 0 ? "" : `: ${summary}`}`;
		});
		return [`Archive records: ${records.length}`, `As of sequence: ${value["asOfSequence"]}`, ...records].join("\n");
	}
	return prettyJson(value);
}

// oxlint-disable-next-line complexity
export function summarizeToolError(error: JsonObject): string {
	const lines = [
		isTextValue(error["summary"]) ? `Error: ${presentToolText(error["summary"])}` : "Khala action failed.",
	];
	if (isTextValue(error["remediation"])) lines.push(`Next step: ${presentToolText(error["remediation"])}`);
	if (Array.isArray(error["evidenceRefs"]) && error["evidenceRefs"].length > 0) {
		lines.push(`Evidence: ${error["evidenceRefs"].filter(isTextValue).join(", ")}`);
	}
	return lines.join("\n");
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
	WorkView,
} from "./model.js";
export { ApplicationError, ApplicationService } from "./service.js";
