import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { runConclaveSubagent } from "./conclave-subagent.js";
import { toolOperation } from "./extension-results.js";
import { sessionRoleForTool, withNestedConclaveScope } from "./extension-role.js";
import type { ApplicationRuntime } from "./factory.js";
import type { Actor, JsonValue } from "./model.js";
import type { OperationContext } from "./ports.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const conclavePrompt = readFileSync(join(packageRoot, "system-prompts", "conclave.md"), "utf8");

export type ConclaveToolOperation = Readonly<{
	operation: OperationContext;
	usage: () => Usage | undefined;
}>;

function conclaveUsesSubagent(application: ApplicationRuntime): boolean {
	return application.service.getRoleSettings().conclave.mode === "subagent";
}

function createConclaveToolOperation(
	application: ApplicationRuntime,
	parentToolCallId: string,
	context: ExtensionToolContext,
	operation: OperationContext,
	conclavePrompt: string,
): ConclaveToolOperation {
	let usage: Usage | undefined;
	if (!conclaveUsesSubagent(application)) return { operation, usage: () => usage };
	const sessionOperation = { ...operation, sessionId: context.sessionManager.getSessionId() };
	return {
		operation: {
			...sessionOperation,
			runConclaveSubagent: (request) => {
				const capability = application.createConclaveCapability(request.workId);
				return withNestedConclaveScope(parentToolCallId, capability, () =>
					runConclaveSubagent({
						...request,
						toolContext: context,
						systemPrompt: `${context.getSystemPrompt()}\n\n${conclavePrompt}`,
						onProviderUsage: (current) => {
							usage = addProviderUsage(usage, current);
						},
					}),
				);
			},
		},
		usage: () => usage,
	};
}

export function createToolOperation(
	application: ApplicationRuntime,
	pi: ExtensionAPI,
	toolCallId: string,
	context: ExtensionToolContext,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<JsonValue> | undefined,
): ConclaveToolOperation {
	const operation = toolOperation(signal, onUpdate);
	if (sessionRoleForTool(pi, toolCallId) !== "user") return { operation, usage: () => undefined };
	return createConclaveToolOperation(application, toolCallId, context, operation, conclavePrompt);
}

export async function processUserToolEffects(
	application: ApplicationRuntime,
	operation: ConclaveToolOperation,
	actor: Actor,
): Promise<void> {
	if (actor !== "user" || !conclaveUsesSubagent(application)) return;
	await application.service.processPendingEffects(operation.operation);
}

export async function finishUserTool(
	application: ApplicationRuntime,
	operation: ConclaveToolOperation,
	actor: Actor,
): Promise<void> {
	if (actor !== "user") return;
	if (conclaveUsesSubagent(application)) await application.service.processPendingEffects(operation.operation);
	else schedulePendingEffects(application.service);
}

export function schedulePendingEffects(service: ApplicationRuntime["service"]): void {
	queueMicrotask(() => {
		// Effects write durable Archive evidence. Do not retain a tool/session UI
		// context across the asynchronous worker pass; Pi may replace that session.
		void service.processPendingEffects().catch(() => undefined);
	});
}

function addProviderUsage(previous: Usage | undefined, current: Usage): Usage {
	const old = previous ?? emptyUsage();
	const result: Usage = {
		input: sumUsage(old.input, current.input),
		output: sumUsage(old.output, current.output),
		cacheRead: sumUsage(old.cacheRead, current.cacheRead),
		cacheWrite: sumUsage(old.cacheWrite, current.cacheWrite),
		totalTokens: sumUsage(old.totalTokens, current.totalTokens),
		cost: {
			input: sumUsage(old.cost.input, current.cost.input),
			output: sumUsage(old.cost.output, current.cost.output),
			cacheRead: sumUsage(old.cost.cacheRead, current.cost.cacheRead),
			cacheWrite: sumUsage(old.cost.cacheWrite, current.cost.cacheWrite),
			total: sumUsage(old.cost.total, current.cost.total),
		},
	};
	const cacheWrite1h = sumOptionalUsage(old.cacheWrite1h, current.cacheWrite1h);
	const reasoning = sumOptionalUsage(old.reasoning, current.reasoning);
	if (cacheWrite1h !== undefined) result.cacheWrite1h = cacheWrite1h;
	if (reasoning !== undefined) result.reasoning = reasoning;
	return result;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function sumUsage(previous: number, current: number): number {
	return previous + current;
}

function sumOptionalUsage(previous: number | undefined, current: number | undefined): number | undefined {
	if (previous === undefined) return current;
	if (current === undefined) return previous;
	return previous + current;
}
