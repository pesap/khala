import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { PromptIdentity } from "./model.js";
import type { AgentRuntimePort, RuntimeBinding, RuntimeState } from "./ports.js";

export type PiRuntimeOptions = Readonly<{
	command: readonly string[];
	extensionPath?: string | undefined;
	baseEnvironment?: NodeJS.ProcessEnv | undefined;
}>;

type RpcData = Readonly<{
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	isStreaming?: boolean | undefined;
}>;

type RpcBlock = Readonly<{
	type?: string | undefined;
	text?: string | undefined;
}>;

type RpcMessage = Readonly<{
	role?: string | undefined;
	content?: readonly RpcBlock[] | undefined;
}>;

type RpcEvent = Readonly<{
	type?: string | undefined;
	id?: string | undefined;
	command?: string | undefined;
	success?: boolean | undefined;
	data?: RpcData | undefined;
	error?: string | undefined;
	message?: RpcMessage | undefined;
}>;

type RpcResponse = Readonly<{
	type: "response";
	id?: string | undefined;
	command: string;
	success: boolean;
	data?: RpcData | undefined;
	error?: string | undefined;
}>;

type PendingResponse = Readonly<{
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
}>;

type MutableChild = {
	process: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingResponse>;
	binding: RuntimeBinding;
	buffer: string;
	lastOutput: string;
	lastAgentEnd: Promise<string> | undefined;
	resolveAgentEnd: ((output: string) => void) | undefined;
	rejectAgentEnd: ((error: Error) => void) | undefined;
};

type RpcCommandData = Readonly<{ message?: string | undefined }>;

export class PiRpcRuntime implements AgentRuntimePort {
	private readonly children = new Map<string, MutableChild>();
	private readonly options: PiRuntimeOptions;

	constructor(options: PiRuntimeOptions) {
		this.options = options;
	}

	async ensureSession(input: Parameters<AgentRuntimePort["ensureSession"]>[0]): Promise<RuntimeBinding> {
		const args = [
			...this.options.command.slice(1),
			"--mode",
			"rpc",
			"--model",
			input.model,
			"--thinking",
			input.thinking,
		];
		if (input.sessionPath !== undefined) {
			args.push("--session", input.sessionPath);
		}
		if (input.tools.length === 0) {
			args.push("--no-tools");
		} else {
			args.push("--tools", input.tools.join(","));
		}
		if (this.options.extensionPath !== undefined) {
			args.push("--extension", this.options.extensionPath);
		}
		args.push("--khala-role", input.role);
		const child: MutableChild = {
			process: spawn(this.options.command[0] ?? "pi", args, {
				cwd: input.cwd,
				env: { ...process.env, ...this.options.baseEnvironment },
				stdio: ["pipe", "pipe", "pipe"],
			}),
			pending: new Map(),
			binding: { sessionId: "starting", sessionPath: input.sessionPath ?? "" },
			buffer: "",
			lastOutput: "",
			lastAgentEnd: undefined,
			resolveAgentEnd: undefined,
			rejectAgentEnd: undefined,
		};
		const key = `child-${++childCounter}`;
		this.children.set(key, child);
		attachOutput(child);
		try {
			const state = await request(child, "get_state", {});
			if (!state.success) {
				throw new Error(state.error ?? "Pi did not return its session state.");
			}
			const sessionId = readSessionText(state.data, "sessionId");
			const sessionPath = readSessionText(state.data, "sessionFile");
			child.binding = { sessionId, sessionPath };
			this.children.delete(key);
			this.children.set(sessionId, child);
			return child.binding;
		} catch (error) {
			this.children.delete(key);
			child.process.kill();
			throw error;
		}
	}

	async send(binding: RuntimeBinding, message: string): Promise<string> {
		const child = this.requireChild(binding);
		const completion = waitForAgentEnd(child);
		try {
			const response = await request(child, "prompt", { message });
			if (!response.success) {
				throw new Error(response.error ?? "Pi rejected the prompt.");
			}
			return await completion;
		} catch (error) {
			rejectAgentEnd(child, error instanceof Error ? error : new Error(String(error)));
			await completion.catch(() => undefined);
			throw error;
		}
	}

	async getState(binding: RuntimeBinding): Promise<RuntimeState> {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			return "unreachable";
		}
		try {
			const response = await request(child, "get_state", {});
			if (!response.success) {
				return "unknown";
			}
			return response.data?.isStreaming === true ? "working" : "idle";
		} catch {
			return "unreachable";
		}
	}

	async requestStop(binding: RuntimeBinding): Promise<void> {
		const child = this.requireChild(binding);
		await request(child, "abort", {});
	}

	async close(): Promise<void> {
		for (const child of this.children.values()) {
			rejectAgentEnd(child, new Error("Pi runtime closed."));
			child.process.kill();
		}
		this.children.clear();
	}

	private requireChild(binding: RuntimeBinding): MutableChild {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			throw new Error(`Pi session ${binding.sessionId} is not attached to this process.`);
		}
		return child;
	}
}

function attachOutput(child: MutableChild): void {
	const decoder = new StringDecoder("utf8");
	child.process.stdout.on("data", (chunk: Buffer) => {
		child.buffer += decoder.write(chunk);
		consumeLines(child);
	});
	child.process.stderr.on("data", () => undefined);
	child.process.on("error", (error) => {
		for (const pending of child.pending.values()) {
			pending.reject(error);
		}
		child.pending.clear();
		rejectAgentEnd(child, error);
	});
	child.process.on("exit", () => {
		const error = new Error("Pi child exited before responding.");
		for (const pending of child.pending.values()) {
			pending.reject(error);
		}
		child.pending.clear();
		rejectAgentEnd(child, error);
	});
}

function consumeLines(child: MutableChild): void {
	for (;;) {
		const newline = child.buffer.indexOf("\n");
		if (newline < 0) {
			return;
		}
		let line = child.buffer.slice(0, newline);
		child.buffer = child.buffer.slice(newline + 1);
		if (line.endsWith("\r")) {
			line = line.slice(0, -1);
		}
		if (line.trim().length === 0) {
			continue;
		}
		let event: RpcEvent;
		try {
			// SAFETY: Pi RPC emits one JSON object per LF-delimited event; consumers validate required fields below.
			event = JSON.parse(line) as RpcEvent;
		} catch {
			continue;
		}
		if (event.type === "response") {
			let response: RpcResponse;
			try {
				response = readResponse(event);
			} catch {
				continue;
			}
			if (response.id !== undefined) {
				const pending = child.pending.get(response.id);
				if (pending !== undefined) {
					child.pending.delete(response.id);
					pending.resolve(response);
				}
			}
			continue;
		}
		if (event.type === "message_end" && isAssistantMessage(event.message)) {
			child.lastOutput = assistantText(event.message);
		}
		if (event.type === "agent_end") {
			resolveAgentEnd(child);
		}
	}
}

let requestCounter = 0;
let childCounter = 0;

function request(child: MutableChild, command: string, data: RpcCommandData): Promise<RpcResponse> {
	const id = `khala-${++requestCounter}`;
	const payload = JSON.stringify({ id, type: command, ...data });
	return new Promise((resolve, reject) => {
		child.pending.set(id, { resolve, reject });
		try {
			child.process.stdin.write(`${payload}\n`);
		} catch (error) {
			child.pending.delete(id);
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function waitForAgentEnd(child: MutableChild): Promise<string> {
	if (child.lastAgentEnd !== undefined) {
		return child.lastAgentEnd;
	}
	child.lastAgentEnd = new Promise((resolve, reject) => {
		child.resolveAgentEnd = resolve;
		child.rejectAgentEnd = reject;
	});
	return child.lastAgentEnd;
}

function resolveAgentEnd(child: MutableChild): void {
	if (child.resolveAgentEnd !== undefined) {
		child.resolveAgentEnd(child.lastOutput);
	}
	child.resolveAgentEnd = undefined;
	child.rejectAgentEnd = undefined;
	child.lastAgentEnd = undefined;
}

function rejectAgentEnd(child: MutableChild, error: Error): void {
	if (child.rejectAgentEnd !== undefined) {
		child.rejectAgentEnd(error);
	}
	child.resolveAgentEnd = undefined;
	child.rejectAgentEnd = undefined;
	child.lastAgentEnd = undefined;
}

function readResponse(value: RpcEvent): RpcResponse {
	if (
		value.type !== "response" ||
		value.command === undefined ||
		value.command !== String(value.command) ||
		(value.success !== true && value.success !== false)
	) {
		throw new Error("Pi RPC response is invalid.");
	}
	return {
		type: "response",
		id: value.id,
		command: value.command,
		success: value.success,
		data: value.data,
		error: value.error,
	};
}

function readSessionText(value: RpcData | undefined, key: "sessionId" | "sessionFile"): string {
	const entry = value?.[key];
	if (entry === undefined || entry !== String(entry) || entry.length === 0) {
		throw new Error(`Pi RPC state is missing ${key}.`);
	}
	return entry;
}

function isAssistantMessage(
	value: RpcMessage | undefined,
): value is RpcMessage & Readonly<{ role: "assistant"; content: readonly RpcBlock[] }> {
	return value !== undefined && value.role === "assistant" && value.content !== undefined;
}

function assistantText(message: Readonly<{ content: readonly RpcBlock[] }>): string {
	return message.content
		.filter((block) => block.type === "text" && block.text !== undefined)
		.map((block) => block.text ?? "")
		.join("\n")
		.trim();
}

export function promptIdentity(prompt: string, packageVersion: string): PromptIdentity {
	return { packageVersion, promptSha256: createHash("sha256").update(prompt).digest("hex") };
}
