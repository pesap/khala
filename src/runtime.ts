import { createHash } from "node:crypto";
import type { PromptIdentity } from "./model.js";
import {
	type AgentRuntimePort,
	type OperationContext,
	type RuntimeBinding,
	type RuntimeInvocationEvidence,
	type RuntimeSendOptions,
	type RuntimeState,
	type RuntimeTurn,
	RuntimeTurnError,
} from "./ports.js";
import { beginInvocation, invocationWriterIsSettled, reconcilePersistedInvocation } from "./runtime-invocation.js";
import {
	assertChildRunning,
	cleanupStartingChild,
	createSessionLaunch,
	createStartingChild,
	prepareSessionLaunch,
	removeSessionCapability,
	spawnSessionSafely,
	startupSessionId,
	verifyNativePiVersion,
	writePersistentLaunchLease,
} from "./runtime-launch.js";
import { createRuntimeStorage, type RuntimeStorage } from "./runtime-storage.js";

export { SUPPORTED_NATIVE_PI_VERSION } from "./runtime-launch.js";

import { isTransientStartupFailure, sameBindingIdentity } from "./runtime-process.js";
import {
	agentTimeout,
	attachOutput,
	awaitOperation,
	childRuntimeState,
	cleanupChild,
	completedTurn,
	createAbortHandler,
	failTurn,
	readRuntimeTokenAllowance,
	registerAbortHandler,
	rejectAgentEnd,
	rejectPending,
	removeAbortHandler,
	request,
	requestAbortBestEffort,
	rpcTimeout,
	sendPrompt,
	stopUnattachedBinding,
	throwIfAborted,
	unattachedRuntimeState,
	validateMaxRpcFrameBytes,
	waitForAgentSettled,
} from "./runtime-protocol.js";
import type { MutableChild, PiRuntimeOptions, SessionInput, SessionLaunch } from "./runtime-types.js";

export type { PiRuntimeOptions } from "./runtime-types.js";

let childCounter = 0;

export class PiRpcRuntime implements AgentRuntimePort {
	private readonly children = new Map<string, MutableChild>();
	private readonly sessionLaunches = new Map<string, Promise<RuntimeBinding>>();
	private readonly launches = new Set<Promise<RuntimeBinding>>();
	private readonly activeRunIds = new Set<string>();
	private readonly options: PiRuntimeOptions;
	private readonly storage: RuntimeStorage;
	private closing = false;

	constructor(options: PiRuntimeOptions) {
		validateMaxRpcFrameBytes(options.maxRpcFrameBytes);
		this.options = options;
		this.storage = createRuntimeStorage(options.projectPath);
	}

	async ensureSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation?: OperationContext,
	): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		throwIfAborted(operation);
		return input.sessionPath === undefined
			? this.trackLaunch(this.startSessionWithRetry(input, operation))
			: this.ensurePersistentSession(input, operation);
	}

	private ensurePersistentSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const sessionPath = input.sessionPath ?? "";
		const active = this.sessionLaunches.get(sessionPath);
		return active === undefined
			? this.startPersistentSession(input, sessionPath, operation)
			: awaitOperation(active, operation);
	}

	private startPersistentSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		sessionPath: string,
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const launch = this.trackLaunch(this.startSessionWithRetry(input, operation));
		this.sessionLaunches.set(sessionPath, launch);
		return launch.finally(() => {
			if (this.sessionLaunches.get(sessionPath) === launch) this.sessionLaunches.delete(sessionPath);
		});
	}

	private async startSessionWithRetry(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		try {
			return await this.startSession(input, operation);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!isTransientStartupFailure(message)) throw error;
			return this.startSession(input, operation);
		}
	}
	private async startSession(
		input: Parameters<AgentRuntimePort["ensureSession"]>[0],
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		if (this.closing) throw new Error("Pi runtime is closed.");
		throwIfAborted(operation);
		await verifyNativePiVersion(this.options.command, input.cwd);
		const launch = createSessionLaunch(input, this.options, this.storage);
		await prepareSessionLaunch(input, launch);
		const childProcess = await spawnSessionSafely(this.options.command[0], launch, input);
		const child = createStartingChild(childProcess, input, launch, this.options);
		await this.registerStartingChild(input, launch, child);
		return this.completeSessionStartup(input, launch, child, operation);
	}

	private async registerStartingChild(input: SessionInput, launch: SessionLaunch, child: MutableChild): Promise<void> {
		try {
			if (this.closing) throw new Error("Pi runtime is closed.");
			await writePersistentLaunchLease(input, launch, child);
		} catch (error) {
			await cleanupStartingChild(launch, child);
			throw error;
		}
	}

	private async completeSessionStartup(
		input: SessionInput,
		launch: SessionLaunch,
		child: MutableChild,
		operation: OperationContext | undefined,
	): Promise<RuntimeBinding> {
		const key = `child-${++childCounter}`;
		this.children.set(key, child);
		child.remove = () => this.removeChild(child);
		attachOutput(
			child,
			() => {
				void cleanupChild(child).catch(() => undefined);
			},
			(error) => {
				if (child.closed) return;
				child.closed = true;
				child.buffer = Buffer.alloc(0);
				rejectPending(child, error);
				rejectAgentEnd(child, error);
				void cleanupChild(child).catch(() => undefined);
			},
		);
		try {
			const state = await request(child, "get_state", {}, rpcTimeout(this.options.rpcTimeoutMs), operation?.signal);
			const sessionId = startupSessionId(state, launch.sessionPath, launch.storage);
			await launch.storage.prepareSessionFile(launch.sessionPath);
			assertChildRunning(child);
			await removeSessionCapability(launch);
			child.binding = { ...child.binding, sessionId, promptIdentity: input.promptIdentity };
			this.children.delete(key);
			this.children.set(sessionId, child);
			return child.binding;
		} catch (error) {
			return this.cleanupFailedSessionStartup(
				key,
				launch,
				child,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	private async cleanupFailedSessionStartup(
		key: string,
		launch: SessionLaunch,
		child: MutableChild,
		error: Error,
	): Promise<never> {
		this.children.delete(key);
		try {
			await removeSessionCapability(launch);
			await cleanupChild(child);
		} catch (cleanupError) {
			throw new Error(`${error.message} (cleanup failed: ${String(cleanupError)})`);
		}
		throw error;
	}
	/**
	 * RPC has no public per-prompt provider cap, so enforcement begins when a completed assistant message is observed.
	 * Abort is reactive: an already-started provider response or tool may finish before the child handles it.
	 */
	async send(
		binding: RuntimeBinding,
		message: string,
		options: RuntimeSendOptions,
		operation?: OperationContext,
	): Promise<RuntimeTurn> {
		const child = this.requireChild(binding);
		if (child.sending) throw new Error(`Pi session ${binding.sessionId} is already processing a prompt.`);
		throwIfAborted(operation);
		const allowance = readRuntimeTokenAllowance(options);
		return this.sendTurn(child, message, options.runId, operation, allowance);
	}

	private async sendTurn(
		child: MutableChild,
		message: string,
		runId: string | undefined,
		operation: OperationContext | undefined,
		tokenAllowance: number,
	): Promise<RuntimeTurn> {
		this.beginTrackedInvocation(child, runId);
		child.turnUsage = undefined;
		child.lastOutput = "";
		child.turnAllowance = tokenAllowance;
		child.allowanceStop = undefined;
		child.sending = true;
		const completion = waitForAgentSettled(child, agentTimeout(child, this.options.agentTimeoutMs));
		const abortHandler = createAbortHandler(child, operation, rpcTimeout(this.options.rpcTimeoutMs));
		registerAbortHandler(operation, abortHandler);
		void completion.catch(() => undefined);
		try {
			await sendPrompt(child, message, rpcTimeout(this.options.rpcTimeoutMs), operation?.signal);
			return await completedTurn(child, completion);
		} catch (error) {
			const failure = new RuntimeTurnError(error instanceof Error ? error.message : String(error), child.turnUsage);
			throw await failTurn(child, completion, failure);
		} finally {
			removeAbortHandler(operation, abortHandler);
			child.sending = false;
			child.turnAllowance = undefined;
			child.allowanceStop = undefined;
			this.finishTrackedInvocation(child, runId);
		}
	}

	private beginTrackedInvocation(child: MutableChild, runId: string | undefined): void {
		this.assertRunAvailable(runId);
		if (child.invocationWriter !== undefined)
			throw new Error(`Pi session ${child.binding.sessionId} has incomplete invocation cleanup.`);
		child.invocationWriter = beginInvocation(runId, child.binding, this.storage);
		if (runId !== undefined) this.activeRunIds.add(runId);
	}

	private assertRunAvailable(runId: string | undefined): void {
		if (runId !== undefined && this.activeRunIds.has(runId))
			throw new Error(`Runtime invocation ${runId} is already active in this runtime.`);
	}

	private finishTrackedInvocation(child: MutableChild, runId: string | undefined): void {
		if (invocationWriterIsSettled(child.invocationWriter)) child.invocationWriter = undefined;
		if (runId !== undefined) this.activeRunIds.delete(runId);
	}

	async reconcileInvocation(runId: string, operation?: OperationContext): Promise<RuntimeInvocationEvidence> {
		throwIfAborted(operation);
		if (this.activeRunIds.has(runId)) throw new Error(`Runtime invocation ${runId} is still active in this runtime.`);
		const evidence = await reconcilePersistedInvocation(runId, this.storage);
		throwIfAborted(operation);
		return evidence;
	}
	async getState(binding: RuntimeBinding, operation?: OperationContext): Promise<RuntimeState> {
		throwIfAborted(operation);
		const child = this.children.get(binding.sessionId);
		if (child === undefined) return unattachedRuntimeState(binding);
		if (!sameBindingIdentity(binding, child.binding)) return unattachedRuntimeState(child.binding);
		if (child.sending) return "working";
		return this.readChildState(child, operation);
	}

	private async readChildState(child: MutableChild, operation: OperationContext | undefined): Promise<RuntimeState> {
		try {
			const response = await request(child, "get_state", {}, this.options.rpcTimeoutMs ?? 10_000, operation?.signal);
			return childRuntimeState(response);
		} catch {
			throwIfAborted(operation);
			await cleanupChild(child);
			return "unreachable";
		}
	}

	async requestStop(binding: RuntimeBinding): Promise<void> {
		const child = this.children.get(binding.sessionId);
		if (child === undefined) {
			await stopUnattachedBinding(binding, this.storage);
			return;
		}
		if (!sameBindingIdentity(binding, child.binding)) return;
		await requestAbortBestEffort(child, this.options.rpcTimeoutMs ?? 10_000);
		await cleanupChild(child);
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		await Promise.allSettled(this.launches);
		const failures = await cleanupRuntimeChildren(this.children.values());
		if (failures.length > 0) throw failures[0];
	}

	private trackLaunch(launch: Promise<RuntimeBinding>): Promise<RuntimeBinding> {
		this.launches.add(launch);
		void launch.finally(() => this.launches.delete(launch)).catch(() => undefined);
		return launch;
	}

	private removeChild(child: MutableChild): void {
		for (const [key, value] of this.children) {
			if (value === child) {
				this.children.delete(key);
			}
		}
	}

	private requireChild(binding: RuntimeBinding): MutableChild {
		const child = this.children.get(binding.sessionId);
		if (child === undefined || !sameBindingIdentity(binding, child.binding)) {
			throw new Error(`Pi session ${binding.sessionId} is not attached with the supplied binding.`);
		}
		return child;
	}
}

async function cleanupRuntimeChildren(children: Iterable<MutableChild>): Promise<Error[]> {
	const failures: Error[] = [];
	for (const child of children) {
		rejectAgentEnd(child, new Error("Pi runtime closed."));
		try {
			await cleanupChild(child);
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	return failures;
}

export function promptIdentity(prompt: string, packageVersion: string): PromptIdentity {
	return { packageVersion, promptSha256: createHash("sha256").update(prompt).digest("hex") };
}
