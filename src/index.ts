import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { persistRoleSetting } from "./config.js";
import { type ApplicationRuntime, createApplication } from "./factory.js";
import type { Actor, CommandMeta, JsonObject, JsonValue, MutableRecordQuery, RecordKind } from "./model.js";
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
	observationId: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
});
const performSchema = Type.Object({
	action: Type.Union([
		Type.Literal("admit"),
		Type.Literal("launch-observer"),
		Type.Literal("record-assessment"),
		Type.Literal("start-execution"),
		Type.Literal("record-signal"),
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
	let runtime: RuntimeState | undefined;
	let executorStatusTimer: ReturnType<typeof setInterval> | undefined;
	let userContext: ExtensionContext | undefined;

	const getRuntime = (context: ExtensionContext): ApplicationRuntime => {
		const trusted = context.isProjectTrusted?.() === true;
		if (runtimeMatches(runtime, context.cwd, trusted)) return runtime.runtime;
		runtime = createRuntimeState(context.cwd, trusted);
		return runtime.runtime;
	};

	pi.registerTool({
		name: "khala_submit_work",
		label: "Submit Work",
		description: "Submit complete User intent to the project Conclave without waiting for admission.",
		parameters: submitSchema,
		async execute(toolCallId, params: SubmitParams, _signal, _onUpdate, context) {
			try {
				const service = getRuntime(context).service;
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
				const page = getRuntime(context).service.readRecords(
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
				const service = getRuntime(context).service;
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
				const work = await getRuntime(context).service.inspectRuntime(
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
			const result = await getRuntime(context).service.perform({
				action: "record-signal",
				workId: params.workId,
				input: { kind: params.kind, summary: params.summary, evidence: params.evidence },
				meta: meta("executor", `tool:signal:${toolCallId}`, params.expectedWorkRevision),
			});
			return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
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
			const result = await getRuntime(context).service.perform({
				action: "record-assessment",
				workId: params.workId,
				input: { summary: params.summary, evidence: params.evidence },
				meta: meta("observer", `tool:assessment:${toolCallId}`, params.expectedWorkRevision),
			});
			return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
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
			const result = await getRuntime(context).service.perform({
				action: "run-oracle",
				workId: params.workId,
				input: { subject: params.subject },
				meta: meta("conclave", `tool:oracle:${toolCallId}`, params.expectedWorkRevision),
			});
			return "error" in result ? toolResult(result.error, true) : toolResult(result.value, false);
		},
	});

	pi.registerCommand("khala", {
		description: "Open the Khala view.",
		handler: async (_args, context) => {
			try {
				const application = getRuntime(context);
				await showKhala(application.service, context, sessionActor(pi), application.config.keybindings, {
					get: () => application.service.getRoleSettings(),
					set: (role, setting, value) => {
						persistRoleSetting(role, setting, value);
						application.updateRoleSetting(role, setting, value);
					},
				});
				updateExecutorStatus(application.service, context);
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("khala-recover", {
		description: "Reread Archive state and reconcile Khala runtime bindings.",
		// oxlint-disable-next-line complexity
		handler: async (_args, context) => {
			try {
				const service = getRuntime(context).service;
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
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, context) => {
		if (sessionRole(pi) === "user") {
			try {
				const application = getRuntime(context);
				userContext = context;
				updateExecutorStatus(application.service, context);
				executorStatusTimer = setInterval(() => updateExecutorStatus(application.service, context), 5_000);
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		}
		setRoleTools(pi);
	});
	pi.on("before_agent_start", (event) => {
		const role = sessionRole(pi);
		if (role === "user") {
			return;
		}
		const prompt = readFileSync(join(packageRoot, "system-prompts", rolePromptFiles[role]), "utf8");
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
	pi.on("session_shutdown", async () => {
		if (executorStatusTimer !== undefined) clearInterval(executorStatusTimer);
		executorStatusTimer = undefined;
		userContext?.ui.setStatus("khala-executors", undefined);
		userContext = undefined;
		if (runtime !== undefined) {
			await runtime.runtime.service.close();
			runtime = undefined;
		}
	});
}

function runtimeMatches(
	runtime: RuntimeState | undefined,
	projectPath: string,
	trusted: boolean,
): runtime is RuntimeState {
	return runtime !== undefined && runtime.projectPath === projectPath && runtime.trusted === trusted;
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
	getRuntime: (context: ExtensionContext) => ApplicationRuntime,
	toolCallId: string,
	params: PerformParams,
	context: ExtensionContext,
): Promise<ToolResult | ToolErrorResult> {
	try {
		const actor = sessionActor(pi);
		const service = getRuntime(context).service;
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
	return SESSION_ROLES.get(String(value)) === value;
}

function sessionActor(pi: ExtensionAPI): Actor {
	return sessionRole(pi);
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
	return values.map((value) => {
		if (!isRecordKind(value)) throw new Error(`Archive record kind ${value} is invalid.`);
		return value;
	});
}

function isRecordKind(value: string): value is RecordKind {
	return [
		"submission",
		"assessment",
		"learning",
		"mission",
		"mission-change",
		"execution",
		"signal",
		"review-request",
		"observation",
		"delivery",
		"verdict",
		"oracle-review",
		"outcome",
		"error",
		"work-amended",
	].includes(value);
}

function toolResult(value: JsonValue, isError: boolean): ToolResult {
	return { content: [{ type: "text", text: summarizeToolValue(value) }], details: value, isError };
}

function toolError(error: JsonObject): ToolErrorResult {
	return { content: [{ type: "text", text: summarizeToolError(error) }], details: error, isError: true };
}

function toolErrorText(message: string): ToolErrorResult {
	return toolError({ summary: message });
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
	WorkView,
} from "./model.js";
export { ApplicationError, ApplicationService } from "./service.js";
