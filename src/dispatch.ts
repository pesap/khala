import type { TokenUsage } from "./model.js";
import { RuntimeTurnError } from "./ports.js";
import type { InvocationRole, ReservedInvocation, RunLedger } from "./run-ledger.js";

export type DispatchInvocationInput = Readonly<{
	workId: string;
	role: InvocationRole;
	missionId?: string | undefined;
	executionId?: string | undefined;
	allowance: number;
	runId?: string | undefined;
	maxConcurrentRuns?: number | undefined;
}>;

export type InvocationSender<T extends { usage?: TokenUsage | undefined }> = (
	reservation: Pick<ReservedInvocation, "runId" | "allowance">,
) => Promise<T>;

/** Only the trusted launcher can establish that no model prompt was attempted. */
export class InvocationLaunchError extends Error {
	readonly cause: Error;
	constructor(cause: Error) {
		super(cause.message);
		this.cause = cause;
		this.name = "InvocationLaunchError";
	}
}

export async function dispatchInvocation<T extends { usage?: TokenUsage | undefined }>(
	ledger: RunLedger,
	input: DispatchInvocationInput,
	send: InvocationSender<T>,
): Promise<T> {
	const reservation = ledger.reserve(input);
	if (reservation.duplicate) throw new Error(`Invocation ${reservation.runId} requires reconciliation.`);
	let turn: T;
	try {
		turn = await send({ runId: reservation.runId, allowance: reservation.allowance });
	} catch (error) {
		settleInvocationFailure(ledger, reservation.runId, error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
	// Persistence failures are not provider failures and must not rewrite the observed result.
	ledger.settle({ runId: reservation.runId, usage: turn.usage, complete: turn.usage !== undefined });
	return turn;
}

function settleInvocationFailure(ledger: RunLedger, runId: string, error: Error): void {
	if (error instanceof InvocationLaunchError) {
		ledger.settle({
			runId,
			usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
			complete: true,
		});
		return;
	}
	const usage = error instanceof RuntimeTurnError ? error.usage : undefined;
	ledger.settle({ runId, usage, complete: false });
}
