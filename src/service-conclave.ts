import { InvocationLaunchError } from "./dispatch.js";
import type { ConclaveWakeCause, PromptIdentity, TokenUsage, WorkView } from "./model.js";
import {
	type AgentRuntimePort,
	type OperationContext,
	type RuntimeBinding,
	type RuntimeTurn,
	RuntimeTurnError,
} from "./ports.js";
import { ConclaveTokenExhaustedError } from "./service-contracts.js";
import { wakeResolutionMissing } from "./service-foundation-policy.js";
import type { InvocationCoordinator } from "./service-invocation-coordinator.js";
import { conclaveWakeMessage } from "./service-runtime-policy.js";
import { tokenUsageTotal } from "./service-state-policy.js";

type ConclaveWakeInput = Readonly<{
	work: WorkView;
	workId: string;
	observationId: string | undefined;
	reason: ConclaveWakeCause;
	allowance: number;
	projectPath: string;
	model: string;
	thinking: string;
	promptIdentity: PromptIdentity;
	runtime: AgentRuntimePort;
	invocations: Pick<InvocationCoordinator, "dispatch">;
	inspectWork: (workId: string) => WorkView;
}>;

type BindingSink = (binding: RuntimeBinding) => void;

export async function runConclaveWake(input: ConclaveWakeInput): Promise<void> {
	let binding: RuntimeBinding | undefined;
	try {
		const turn = await dispatchConclaveTurn(input, (next) => {
			binding = next;
		});
		const usage = turnUsageAtAllowance(turn.usage, input.allowance);
		if (usage !== undefined && wakeNeedsDecision(input)) throw new ConclaveTokenExhaustedError(usage, input.allowance);
	} finally {
		if (binding !== undefined) await input.runtime.requestStop(binding).catch(() => undefined);
	}
}

async function dispatchConclaveTurn(input: ConclaveWakeInput, setBinding: BindingSink): Promise<RuntimeTurn> {
	try {
		return await input.invocations.dispatch(
			input.work,
			{ workId: input.workId, role: "conclave", allowance: input.allowance },
			async (reservation, operation) => {
				const binding = await ensureConclaveSession(input, operation);
				setBinding(binding);
				const live = input.inspectWork(input.workId);
				return input.runtime.send(
					binding,
					`${conclaveWakeMessage(live, input.observationId, input.reason)}\nInvocation run ID: ${reservation.runId}.`,
					{ tokenAllowance: reservation.allowance, runId: reservation.runId },
					operation,
				);
			},
		);
	} catch (error) {
		throw rewriteTokenExhaustion(error instanceof Error ? error : new Error(String(error)), input.allowance);
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
				tools: ["khala_read_archive", "khala_inspect_runtime", "khala_perform_action", "khala_run_oracle"],
			},
			operation,
		);
	} catch (error) {
		throw new InvocationLaunchError(new Error(String(error)));
	}
}

function wakeNeedsDecision(input: ConclaveWakeInput): boolean {
	return wakeResolutionMissing(input.work, input.inspectWork(input.workId), input.reason);
}

function rewriteTokenExhaustion(error: Error, allowance: number): Error {
	const usage = error instanceof RuntimeTurnError ? turnUsageAtAllowance(error.usage, allowance) : undefined;
	return usage === undefined ? error : new ConclaveTokenExhaustedError(usage, allowance);
}

function turnUsageAtAllowance(usage: TokenUsage | undefined, allowance: number): TokenUsage | undefined {
	return usage !== undefined && tokenUsageTotal(usage) >= allowance ? usage : undefined;
}
