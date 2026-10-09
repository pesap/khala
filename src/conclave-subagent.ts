import type {
	AssistantMessage,
	Message,
	SimpleStreamOptions,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CONCLAVE_TOOL_NAMES } from "./extension-role.js";
import { type ConclaveSubagentRequest, type RuntimeTurn, RuntimeTurnError } from "./ports.js";
import type { RpcUsage } from "./runtime-types.js";
import { addTokenUsage, readTokenUsage } from "./runtime-usage.js";

const MAX_CONCLAVE_SUBAGENT_TURNS = 32;

type ConclaveSubagentInput = ConclaveSubagentRequest &
	Readonly<{
		toolContext: ExtensionToolContext;
		systemPrompt: string;
		onProviderUsage: (usage: Usage) => void;
	}>;

type ConclaveTurnState = {
	messages: Message[];
	usage: RuntimeTurn["usage"];
};

type ConclaveTurnResult = Readonly<{ kind: "continue" }> | Readonly<{ kind: "complete"; turn: RuntimeTurn }>;

export async function runConclaveSubagent(input: ConclaveSubagentInput): Promise<RuntimeTurn> {
	const model = findConclaveModel(input.toolContext, input.model);
	const tools = conclaveTools(input.toolContext.tools);
	const state: ConclaveTurnState = {
		messages: [{ role: "user", content: input.message, timestamp: Date.now() }],
		usage: undefined,
	};
	const reasoning = readThinkingLevel(input.thinking);
	try {
		return await runConclaveTurns(input, model, tools, state, reasoning);
	} catch (error) {
		if (error instanceof RuntimeTurnError) throw error;
		throw new RuntimeTurnError(error instanceof Error ? error.message : String(error), state.usage);
	}
}

async function runConclaveTurns(
	input: ConclaveSubagentInput,
	model: ReturnType<typeof findConclaveModel>,
	tools: Tool[],
	state: ConclaveTurnState,
	reasoning: ThinkingLevel | undefined,
): Promise<RuntimeTurn> {
	for (let turn = 0; turn < MAX_CONCLAVE_SUBAGENT_TURNS; turn += 1) {
		throwIfAborted(input.signal);
		const result = await runConclaveTurn(input, model, tools, state, reasoning);
		if (result.kind === "complete") return result.turn;
	}
	throw new Error(`Conclave exceeded its ${MAX_CONCLAVE_SUBAGENT_TURNS}-turn limit.`);
}

async function runConclaveTurn(
	input: ConclaveSubagentInput,
	model: ReturnType<typeof findConclaveModel>,
	tools: Tool[],
	state: ConclaveTurnState,
	reasoning: ThinkingLevel | undefined,
): Promise<ConclaveTurnResult> {
	const assistant = await streamConclaveTurn(input, model, tools, state.messages, reasoning);
	state.usage = await accumulateConclaveUsage(input, assistant, state.usage);
	assertAssistantCompleted(assistant);
	state.messages.push(assistant);
	if (tokenAllowanceReached(state.usage, input.tokenAllowance))
		return { kind: "complete", turn: resultTurn(assistant, state.usage) };
	const calls = toolCalls(assistant);
	if (calls.length === 0) return { kind: "complete", turn: resultTurn(assistant, state.usage) };
	await appendConclaveToolResults(input, calls, state.messages);
	return { kind: "continue" };
}

async function streamConclaveTurn(
	input: ConclaveSubagentInput,
	model: ReturnType<typeof findConclaveModel>,
	tools: Tool[],
	messages: Message[],
	reasoning: ThinkingLevel | undefined,
): Promise<AssistantMessage> {
	const options: SimpleStreamOptions = {};
	if (reasoning !== undefined) options.reasoning = reasoning;
	if (input.signal !== undefined) options.signal = input.signal;
	const stream = input.toolContext.modelRegistry.streamSimple(
		model,
		{ systemPrompt: input.systemPrompt, messages: [...messages], tools },
		options,
	);
	return stream.result();
}

async function accumulateConclaveUsage(
	input: ConclaveSubagentInput,
	assistant: AssistantMessage,
	previous: RuntimeTurn["usage"],
): Promise<RuntimeTurn["usage"]> {
	if (assistant.usage === undefined) return previous;
	input.onProviderUsage(assistant.usage);
	const current = readTokenUsage(assistantUsage(assistant));
	if (current === undefined) return previous;
	const usage = addTokenUsage(previous, current);
	await input.onUsage(usage);
	return usage;
}

function findConclaveModel(context: ExtensionToolContext, reference: string) {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1)
		throw new Error(`Conclave model ${reference} must use provider/model form.`);
	const model = context.modelRegistry.find(reference.slice(0, separator), reference.slice(separator + 1));
	if (model === undefined) throw new Error(`Conclave model ${reference} is not available in Pi.`);
	return model;
}

function conclaveTools(tools: readonly ExtensionToolContext["tools"][number][]): Tool[] {
	return tools
		.filter((tool) => CONCLAVE_TOOL_NAMES.has(tool.name))
		.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function readThinkingLevel(value: string): ThinkingLevel | undefined {
	if (value === "off") return undefined;
	const levels: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	const level = levels.find((candidate) => candidate === value);
	if (level !== undefined) return level;
	throw new Error(`Conclave thinking level ${value} is not supported by the nested Pi model API.`);
}

function assistantUsage(message: AssistantMessage): RpcUsage {
	return {
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
	};
}

function assertAssistantCompleted(message: AssistantMessage): void {
	if (message.stopReason === "error" || message.stopReason === "aborted") throw providerStopError(message);
	if (isIncompleteStopReason(message.stopReason))
		throw new Error(`Conclave provider returned an incomplete ${message.stopReason} response.`);
}

function providerStopError(message: AssistantMessage): Error {
	if (message.errorMessage !== undefined) return new Error(message.errorMessage);
	return new Error(`Conclave provider stopped with ${message.stopReason}.`);
}

function isIncompleteStopReason(reason: AssistantMessage["stopReason"]): boolean {
	return reason === "length" || reason === "deferred";
}

function toolCalls(message: AssistantMessage): readonly ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

async function appendConclaveToolResults(
	input: ConclaveSubagentInput,
	calls: readonly ToolCall[],
	messages: Message[],
): Promise<void> {
	for (const call of calls) messages.push(await executeConclaveTool(input, call));
}

async function executeConclaveTool(input: ConclaveSubagentInput, call: ToolCall): Promise<ToolResultMessage> {
	if (!CONCLAVE_TOOL_NAMES.has(call.name)) throw new Error(`Conclave requested an unavailable tool: ${call.name}.`);
	const options = input.signal === undefined ? undefined : { signal: input.signal };
	const outcome = await input.toolContext.executeTool(call.name, call.arguments, options);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: outcome.result.content,
		isError: outcome.isError,
		timestamp: Date.now(),
	};
	if (outcome.result.usage !== undefined) result.usage = outcome.result.usage;
	return result;
}

function tokenAllowanceReached(usage: RuntimeTurn["usage"], allowance: number): boolean {
	return usage !== undefined && usage.inputTokens + usage.outputTokens >= allowance;
}

function resultTurn(message: AssistantMessage, usage: RuntimeTurn["usage"]): RuntimeTurn {
	return usage === undefined ? { output: assistantText(message) } : { output: assistantText(message), usage };
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true)
		throw signal.reason instanceof Error ? signal.reason : new Error("Conclave was aborted.");
}
