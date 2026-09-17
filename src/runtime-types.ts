import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { KeyObject } from "node:crypto";
import type { TokenUsage } from "./model.js";
import type { AgentRuntimePort, RuntimeBinding } from "./ports.js";
import type { RuntimeInvocationWriter } from "./runtime-invocation.js";
import type { RuntimeStorage } from "./runtime-storage.js";

export type PiRuntimeOptions = Readonly<{
	projectPath: string;
	command: readonly string[];
	extensionPath?: string | undefined;
	baseEnvironment?: NodeJS.ProcessEnv | undefined;
	authorityPrivateKey?: KeyObject | undefined;
	rpcTimeoutMs?: number | undefined;
	agentTimeoutMs?: number | undefined;
	maxRpcFrameBytes?: number | undefined;
}>;

export type RpcData = Readonly<{
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	isStreaming?: boolean | undefined;
}>;

export type RpcBlock = Readonly<{
	type?: string | undefined;
	text?: string | undefined;
}>;

export type RpcUsage = Readonly<{
	input?: number | undefined;
	output?: number | undefined;
	cacheRead?: number | undefined;
	cacheWrite?: number | undefined;
}>;

export type RpcMessage = Readonly<{
	role?: string | undefined;
	content?: readonly RpcBlock[] | undefined;
	usage?: RpcUsage | undefined;
}>;

export type RpcEvent = Readonly<{
	type?: string | undefined;
	id?: string | undefined;
	command?: string | undefined;
	success?: boolean | undefined;
	data?: RpcData | undefined;
	error?: string | undefined;
	message?: RpcMessage | undefined;
}>;

export type RpcResponse = Readonly<{
	type: "response";
	id?: string | undefined;
	command: string;
	success: boolean;
	data?: RpcData | undefined;
	error?: string | undefined;
}>;

export type PendingResponse = Readonly<{
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}>;

export type MutableChild = {
	process: ChildProcessWithoutNullStreams;
	pending: Map<string, PendingResponse>;
	binding: RuntimeBinding;
	agentTimeoutMs: number | undefined;
	maxRpcFrameBytes: number;
	buffer: Buffer;
	lastOutput: string;
	turnUsage: TokenUsage | undefined;
	turnAllowance: number | undefined;
	allowanceStop: Promise<void> | undefined;
	rpcTimeoutMs: number;
	lastError: string;
	closed: boolean;
	sending: boolean;
	lastAgentEnd: Promise<string> | undefined;
	resolveAgentEnd: ((output: string) => void) | undefined;
	rejectAgentEnd: ((error: Error) => void) | undefined;
	agentTimer: NodeJS.Timeout | undefined;
	ephemeralSession: boolean;
	storage: RuntimeStorage;
	remove: (() => void) | undefined;
	cleanupPromise: Promise<void> | undefined;
	invocationWriter: RuntimeInvocationWriter | undefined;
};

export type RpcCommandData = Readonly<{ message?: string | undefined }>;
export type SessionInput = Parameters<AgentRuntimePort["ensureSession"]>[0];
export type CapabilityScopeInput = Readonly<{
	workId?: string | undefined;
	executionId?: string | undefined;
	nonce?: string | undefined;
}>;
export type SessionLaunch = Readonly<{
	sessionPath: string;
	args: string[];
	capabilityNonce: string | undefined;
	capabilityToken: string | undefined;
	capabilityFile: string | undefined;
	environment: NodeJS.ProcessEnv;
	processMarker: string;
	storage: RuntimeStorage;
}>;
