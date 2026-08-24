import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { loadConfig } from "./config.js";
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

const actionInputSchema = Type.Object({
	kind: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	evidence: Type.Optional(Type.Array(Type.String())),
	decision: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	signalId: Type.Optional(Type.String()),
	status: Type.Optional(Type.String()),
	feedback: Type.Optional(Type.Array(Type.String())),
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
		Type.Literal("record-review"),
		Type.Literal("record-outcome"),
		Type.Literal("cancel"),
		Type.Literal("recover"),
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

	const getRuntime = (context: ExtensionContext): ApplicationRuntime => {
		const trusted = context.isProjectTrusted?.() === true;
		if (runtime?.projectPath === context.cwd && runtime.trusted === trusted) {
			return runtime.runtime;
		}
		runtime = { runtime: createApplication(context.cwd, trusted, packageRoot), projectPath: context.cwd, trusted };
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
				scheduleWake(service, work.workId, context);
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
		name: "khala_perform_action",
		label: "Perform Khala Action",
		description: "Perform one actor-authorized, revision-checked Khala application action.",
		parameters: performSchema,
		async execute(toolCallId, params: PerformParams, _signal, _onUpdate, context) {
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
				if (error instanceof ApplicationError) {
					return toolError(error.envelope);
				}
				return toolErrorText(error instanceof Error ? error.message : "Khala action failed.");
			}
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
		description: "Open the on-demand Khala Work view.",
		handler: async (_args, context) => {
			try {
				const application = getRuntime(context);
				await showKhala(application.service, context, sessionActor(pi), application.config.keybindings);
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("khala-recover", {
		description: "Reread Archive state and reconcile Khala runtime bindings.",
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
				context.ui.notify(
					`Archive reread and runtime reconciliation completed for ${work.length} Work item${work.length === 1 ? "" : "s"}.`,
					"info",
				);
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("khala-setup", {
		description: "Run Khala's linear configuration preflight.",
		handler: async (_args, context) => {
			try {
				const trusted = context.isProjectTrusted?.() === true;
				const config = loadConfig(context.cwd, trusted, false);
				const statuses = [
					`Ready: Archive root ${config.archiveRoot}`,
					`Ready: target branch ${config.targetBranch}`,
					`${config.conclaveModel.length === 0 ? "Action required" : "Ready"}: Conclave model`,
					`${config.executorModel.length === 0 ? "Action required" : "Ready"}: Executor model`,
					`${config.oracleModel.length === 0 ? "Action required" : "Ready"}: Oracle model`,
					`${config.observerModel.length === 0 ? "Unavailable" : "Ready"}: Observer model`,
				];
				context.ui.notify(statuses.join("\n"), "info");
			} catch (error) {
				context.ui.notify(error instanceof Error ? error.message : "Khala setup preflight failed.", "error");
			}
		},
	});

	pi.on("session_start", (_event, context) => {
		setRoleTools(pi);
		if (sessionActor(pi) !== "user") {
			return;
		}
		context.ui.setStatus("khala", "Khala: on demand");
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
		if (runtime !== undefined) {
			await runtime.runtime.service.close();
			runtime = undefined;
		}
	});
}

function scheduleWake(service: ApplicationRuntime["service"], _workId: string, context: ExtensionContext): void {
	queueMicrotask(() => {
		void service.processPendingEffects().catch((error: Error) => {
			context.ui.notify(error.message, "warning");
		});
	});
}

function schedulePendingEffects(service: ApplicationRuntime["service"]): void {
	queueMicrotask(() => void service.processPendingEffects());
}

function sessionRole(pi: ExtensionAPI): "user" | "conclave" | "observer" | "executor" | "oracle" {
	const value = pi.getFlag(ROLE_FLAG);
	if (value === "conclave" || value === "observer" || value === "executor" || value === "oracle") {
		return value;
	}
	return "user";
}

function sessionActor(pi: ExtensionAPI): Actor {
	return sessionRole(pi);
}

function setRoleTools(pi: ExtensionAPI): void {
	const role = sessionRole(pi);
	const allowed =
		role === "user"
			? new Set(["khala_submit_work", "khala_read_archive", "khala_perform_action", "khala_poll_provider"])
			: role === "conclave"
				? new Set(["khala_read_archive", "khala_perform_action", "khala_run_oracle"])
				: role === "executor"
					? new Set(["khala_read_archive", "khala_record_signal", "khala_perform_action"])
					: role === "observer"
						? new Set(["khala_read_archive", "khala_record_assessment"])
						: new Set(["khala_read_archive"]);
	pi.setActiveTools(pi.getActiveTools().filter((name) => !name.startsWith("khala_") || allowed.has(name)));
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
	const query: MutableRecordQuery = {};
	if (params.workId !== undefined) query.workId = params.workId;
	if ((actor === "observer" || actor === "executor") && query.workId === undefined)
		query.workId = process.env["KHALA_BOUND_WORK_ID"];
	if (params.missionId !== undefined) query.missionId = params.missionId;
	if (params.executionId !== undefined) query.executionId = params.executionId;
	if (params.kinds !== undefined) query.kinds = readRecordKinds(params.kinds);
	if (params.states !== undefined) query.states = params.states;
	if (params.from !== undefined) query.from = params.from;
	if (params.to !== undefined) query.to = params.to;
	return query;
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
			`Next action: ${value["nextAction"]}`,
			`Revision: ${value["revision"] ?? "unknown"}`,
		].join("\n");
	}
	if (isJsonObject(value) && Array.isArray(value["items"]) && isIntegerValue(value["asOfSequence"])) {
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

function summarizeToolError(error: JsonObject): string {
	const lines = [isTextValue(error["summary"]) ? `Error: ${error["summary"]}` : "Khala action failed."];
	if (isTextValue(error["remediation"])) lines.push(`Remediation: ${error["remediation"]}`);
	if (Array.isArray(error["evidenceRefs"]) && error["evidenceRefs"].length > 0) {
		lines.push(`Evidence: ${error["evidenceRefs"].filter(isTextValue).join(", ")}`);
	}
	return lines.join("\n");
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
	Mission,
	RecordView,
	SubmitWorkInput,
	WorkView,
} from "./model.js";
export { ApplicationError, ApplicationService } from "./service.js";
