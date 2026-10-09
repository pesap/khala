import { InvocationLaunchError } from "./dispatch.js";
import type { ConclaveMode, ConclaveWakeCause, PromptIdentity, TokenUsage, WorkView } from "./model.js";
import {
	type AgentRuntimePort,
	type OperationContext,
	type RuntimeBinding,
	type RuntimeTurn,
	RuntimeTurnError,
} from "./ports.js";
import { ConclaveSessionUnavailable, ConclaveTokenExhaustedError } from "./service-contracts.js";
import { wakeResolutionMissing } from "./service-foundation-policy.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { conclaveWakeMessage } from "./service-runtime-policy.js";
import { tokenUsageTotal } from "./service-state-policy.js";
import { TRUSTED_SKILL_TOOLS, type TrustedSkillCatalog } from "./trusted-skills.js";

type ConclaveWakeInput = Readonly<{
	work: WorkView;
	workId: string;
	mode: ConclaveMode;
	operation?: OperationContext | undefined;
	observationId: string | undefined;
	reason: ConclaveWakeCause;
	allowance: number;
	projectPath: string;
	model: string;
	thinking: string;
	promptIdentity: PromptIdentity;
	enableCiRepair: boolean;
	runtime: AgentRuntimePort;
	invocations: Pick<InvocationCoordinator, "dispatch">;
	inspectWork: (workId: string) => WorkView;
	trustedSkillCatalog?: TrustedSkillCatalog | undefined;
}>;

type BindingSink = (binding: RuntimeBinding) => void;
type InvocationReservation = Readonly<{ runId: string; allowance: number }>;

export async function runConclaveWake(input: ConclaveWakeInput): Promise<void> {
	assertSubagentOperation(input);
	let binding: RuntimeBinding | undefined;
	try {
		const turn = await dispatchConclaveTurn(input, (next) => {
			binding = next;
		});
		assertConclaveAllowance(input, turn);
	} finally {
		if (binding !== undefined) await input.runtime.requestStop(binding).catch(() => undefined);
	}
}

function assertSubagentOperation(input: ConclaveWakeInput): void {
	if (input.mode === "subagent" && input.operation?.runConclaveSubagent === undefined)
		throw new ConclaveSessionUnavailable();
}

function assertConclaveAllowance(input: ConclaveWakeInput, turn: RuntimeTurn): void {
	const usage = turnUsageAtAllowance(turn.usage, input.allowance);
	if (usage !== undefined && wakeNeedsDecision(input)) throw new ConclaveTokenExhaustedError(usage, input.allowance);
}

async function dispatchConclaveTurn(input: ConclaveWakeInput, setBinding: BindingSink): Promise<RuntimeTurn> {
	try {
		throwIfAborted(input.operation?.signal);
		return await input.invocations.dispatch(
			input.work,
			{ workId: input.workId, role: "conclave", allowance: input.allowance },
			(reservation, invocationOperation) => sendConclaveInvocation(input, reservation, invocationOperation, setBinding),
		);
	} catch (error) {
		throw rewriteTokenExhaustion(error instanceof Error ? error : new Error(String(error)), input.allowance);
	}
}

async function sendConclaveInvocation(
	input: ConclaveWakeInput,
	reservation: InvocationReservation,
	invocationOperation: OperationContext,
	setBinding: BindingSink,
): Promise<RuntimeTurn> {
	const operation = combineOperation(input.operation, invocationOperation);
	const message = conclaveInvocationMessage(input, reservation.runId);
	if (input.mode === "subagent") return sendNestedConclaveInvocation(input, reservation, operation, message);
	const binding = await ensureConclaveSession(input, operation);
	setBinding(binding);
	return input.runtime.send(
		binding,
		message,
		{ tokenAllowance: reservation.allowance, runId: reservation.runId },
		operation,
	);
}

function conclaveInvocationMessage(input: ConclaveWakeInput, runId: string): string {
	const live = input.inspectWork(input.workId);
	return `${conclaveWakeMessage(live, input.observationId, input.reason, input.enableCiRepair)}\nInvocation run ID: ${runId}.`;
}

async function sendNestedConclaveInvocation(
	input: ConclaveWakeInput,
	reservation: InvocationReservation,
	operation: OperationContext,
	message: string,
): Promise<RuntimeTurn> {
	const runConclaveSubagent = operation.runConclaveSubagent;
	const sessionId = operation.sessionId;
	if (runConclaveSubagent === undefined || sessionId === undefined) throw new ConclaveSessionUnavailable();
	const recorder = await beginNestedRecorder(input.runtime, reservation.runId, sessionId);
	return executeNestedConclaveInvocation(
		runConclaveSubagent,
		recorder,
		input,
		reservation,
		operation,
		sessionId,
		message,
	);
}

async function beginNestedRecorder(runtime: AgentRuntimePort, runId: string, sessionId: string) {
	try {
		return await runtime.beginNestedInvocation(runId, sessionId);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		throw new InvocationLaunchError(failure);
	}
}

async function executeNestedConclaveInvocation(
	runConclaveSubagent: NonNullable<OperationContext["runConclaveSubagent"]>,
	recorder: Awaited<ReturnType<AgentRuntimePort["beginNestedInvocation"]>>,
	input: ConclaveWakeInput,
	reservation: InvocationReservation,
	operation: OperationContext,
	sessionId: string,
	message: string,
): Promise<RuntimeTurn> {
	try {
		const turn = await runConclaveSubagent({
			workId: input.workId,
			runId: reservation.runId,
			sessionId,
			model: input.model,
			thinking: input.thinking,
			message,
			tokenAllowance: reservation.allowance,
			signal: operation.signal,
			onUsage: (usage) => recorder.reportUsage(usage),
		});
		settleNestedRecorder(recorder, turn);
		return turn;
	} catch (error) {
		if (error instanceof RuntimeTurnError) reportFailedNestedUsage(recorder, error);
		stopNestedRecorder(recorder);
		throw error;
	}
}

function settleNestedRecorder(
	recorder: Awaited<ReturnType<AgentRuntimePort["beginNestedInvocation"]>>,
	turn: RuntimeTurn,
): void {
	if (turn.usage === undefined) recorder.stop();
	else recorder.complete(turn.usage);
}

function reportFailedNestedUsage(
	recorder: Awaited<ReturnType<AgentRuntimePort["beginNestedInvocation"]>>,
	error: RuntimeTurnError,
): void {
	if (error.usage === undefined) return;
	try {
		recorder.reportUsage(error.usage);
	} catch {
		// Keep the provider error authoritative if the receipt already lost write access.
	}
}

function stopNestedRecorder(recorder: Awaited<ReturnType<AgentRuntimePort["beginNestedInvocation"]>>): void {
	try {
		recorder.stop();
	} catch {
		// An unconfirmed receipt remains held for explicit reconciliation.
	}
}

async function ensureConclaveSession(input: ConclaveWakeInput, operation: OperationContext): Promise<RuntimeBinding> {
	try {
		return await input.runtime.ensureSession(
			{
				cwd: input.projectPath,
				model: input.model,
				thinking: input.thinking,
				role: "conclave",
				promptIdentity: input.promptIdentity,
				bindingScope: { workId: input.workId },
				tools: conclaveTools(input.trustedSkillCatalog),
			},
			operation,
		);
	} catch (error) {
		throw new InvocationLaunchError(new Error(String(error)));
	}
}

function conclaveTools(catalog: TrustedSkillCatalog | undefined): readonly string[] {
	const core = ["khala_read_archive", "khala_inspect_runtime", "khala_perform_action", "khala_run_oracle"];
	return catalog === undefined || catalog.length === 0 ? core : [...core, ...TRUSTED_SKILL_TOOLS];
}

function wakeNeedsDecision(input: ConclaveWakeInput): boolean {
	return wakeResolutionMissing(input.work, input.inspectWork(input.workId), input.reason);
}

function rewriteTokenExhaustion(error: Error, allowance: number): Error {
	const usage = error instanceof RuntimeTurnError ? turnUsageAtAllowance(error.usage, allowance) : undefined;
	return usage === undefined ? error : new ConclaveTokenExhaustedError(usage, allowance);
}

function combineOperation(outer: OperationContext | undefined, invocation: OperationContext): OperationContext {
	const parent = outer ?? {};
	return {
		signal: combineSignals(parent.signal, invocation.signal),
		onUpdate: parent.onUpdate,
		runConclaveSubagent: parent.runConclaveSubagent,
		sessionId: parent.sessionId,
	};
}

function combineSignals(parent: AbortSignal | undefined, invocation: AbortSignal | undefined): AbortSignal | undefined {
	if (parent === undefined) return invocation;
	if (invocation === undefined) return parent;
	return AbortSignal.any([parent, invocation]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true)
		throw signal.reason instanceof Error ? signal.reason : new Error("Conclave was aborted.");
}

function turnUsageAtAllowance(usage: TokenUsage | undefined, allowance: number): TokenUsage | undefined {
	return usage !== undefined && tokenUsageTotal(usage) >= allowance ? usage : undefined;
}
