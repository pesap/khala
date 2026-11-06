import type { ArchivePort } from "./archive.js";
import { dispatchInvocation, type InvocationSender } from "./dispatch.js";
import { InvocationSteering, type SteeringReceipt } from "./invocation-steering.js";
import type { TokenUsage, WorkView } from "./model.js";
import type { OperationContext } from "./ports.js";
import type { InvocationRole, RunLedger } from "./run-ledger.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable, type ServiceOptions } from "./service-contracts.js";
import { isTerminalWork } from "./service-foundation-policy.js";
import { workMaxConcurrentRuns } from "./service-runtime-policy.js";
import { isDispatchBudgetAttention } from "./service-state-policy.js";
import { DispatchEligibilityError, dispatchEligibility } from "./workflow-dispatch.js";

function sameMission(left: WorkView, right: WorkView): boolean {
	const missionId = left.mission?.missionId;
	return missionId === right.mission?.missionId;
}

function sameExecution(left: WorkView, right: WorkView): boolean {
	const executionId = left.execution?.executionId;
	return executionId === right.execution?.executionId;
}

function hasReservedRun(work: WorkView, runId: string, role: InvocationRole): boolean {
	const run = work.activeInvocations?.find((candidate) => candidate.runId === runId);
	return run?.state === "reserved" && run.role === role;
}

const MAX_RETAINED_STEERING_RUNS = 16;

type ActiveInvocation = {
	workId: string;
	role: InvocationRole;
	controller: AbortController;
	steering: InvocationSteering | undefined;
};

type GovernedInvocationSender<T extends { usage?: TokenUsage | undefined }> = (
	reservation: Parameters<InvocationSender<T>>[0],
	operation: OperationContext,
) => Promise<T>;

export class InvocationCoordinator {
	private readonly activeInvocations = new Map<string, ActiveInvocation>();
	private readonly completedSteering = new Map<
		string,
		Readonly<{ workId: string; receipts: readonly SteeringReceipt[] }>
	>();
	private readonly archive: ArchivePort;
	private readonly core: ArchiveCore;
	private readonly ledger: RunLedger;
	private readonly options: ServiceOptions;

	constructor(archive: ArchivePort, core: ArchiveCore, ledger: RunLedger, options: ServiceOptions) {
		this.archive = archive;
		this.core = core;
		this.ledger = ledger;
		this.options = options;
	}

	async dispatch<T extends { usage?: TokenUsage | undefined }>(
		work: WorkView,
		input: Parameters<typeof dispatchInvocation>[1],
		send: GovernedInvocationSender<T>,
	): Promise<T> {
		const eligibility = dispatchEligibility(work);
		if (eligibility !== "eligible") throw new DispatchEligibilityError(eligibility);
		const limit = workMaxConcurrentRuns(work, this.options);
		if (this.activeInvocationCount() >= limit) throw new RunGateUnavailable();
		this.clearResolvedDispatchAttention(work);
		return dispatchInvocation(this.ledger, { ...input, maxConcurrentRuns: limit }, (reservation) =>
			this.runActive(work.workId, input.role, send, reservation),
		);
	}

	isActive(runId: string): boolean {
		return this.activeInvocations.has(runId);
	}

	steer(workId: string, runId: string, text: string) {
		const invocation = this.activeInvocations.get(runId);
		if (invocation === undefined || invocation.workId !== workId)
			throw new Error("The Work has no matching active invocation.");
		if (invocation.steering === undefined) throw new Error("Steering is unavailable until the receiver is attached.");
		return invocation.steering.enqueue(text);
	}

	readSteering(workId: string, runId: string): readonly SteeringReceipt[] {
		const active = this.matchingSteering(workId, runId);
		if (active !== undefined) return active.snapshot();
		const completed = this.completedSteering.get(runId);
		if (completed === undefined || completed.workId !== workId)
			throw new Error("The Work has no retained steering for this invocation.");
		return completed.receipts.map((receipt) => ({ ...receipt }));
	}

	private matchingSteering(workId: string, runId: string): InvocationSteering | undefined {
		const active = this.activeInvocations.get(runId);
		if (active?.workId !== workId) return;
		return active.steering;
	}

	get activeRuns(): Pick<ReadonlySet<string>, "has"> {
		return this.activeInvocations;
	}

	abortStoppedWork(): void {
		for (const { workId, role, controller } of this.activeInvocations.values()) {
			// Executor stop effects collect final usage; aborting here would race that acknowledgement.
			if (role === "executor") continue;
			this.abortStoppedInvocation(workId, controller);
		}
	}

	private abortStoppedInvocation(workId: string, controller: AbortController): void {
		const work = this.archive.project(workId);
		if (work?.state === "stopped") controller.abort(new Error("Work stopped by an explicit decision."));
	}

	requireCapacity(work: WorkView): void {
		if (this.activeInvocationCount() < workMaxConcurrentRuns(work, this.options)) return;
		throw new RunGateUnavailable();
	}

	private async runActive<T extends { usage?: TokenUsage | undefined }>(
		workId: string,
		role: InvocationRole,
		send: GovernedInvocationSender<T>,
		reservation: Parameters<InvocationSender<T>>[0],
	): Promise<T> {
		const controller = new AbortController();
		const initial = this.archive.project(workId);
		const invocation: ActiveInvocation = { workId, role, controller, steering: undefined };
		this.activeInvocations.set(reservation.runId, invocation);
		try {
			return await send(reservation, {
				signal: controller.signal,
				attachSteering: (signal) => this.attachSteering(reservation.runId, invocation, initial, signal),
			});
		} finally {
			const steering = invocation.steering;
			steering?.close();
			if (steering !== undefined) this.retainSteering(workId, reservation.runId, steering.snapshot());
			this.activeInvocations.delete(reservation.runId);
		}
	}

	private attachSteering(
		runId: string,
		invocation: ActiveInvocation,
		initial: WorkView | undefined,
		signal: AbortSignal | undefined,
	): InvocationSteering {
		if (this.activeInvocations.get(runId) !== invocation) throw new Error("The invocation has settled.");
		if (invocation.steering !== undefined) throw new Error("The invocation already has a steering receiver.");
		const steering = new InvocationSteering(
			() => this.canSteer(invocation.workId, runId, invocation.role, initial, invocation.controller.signal),
			signal,
		);
		invocation.steering = steering;
		return steering;
	}

	private retainSteering(workId: string, runId: string, receipts: readonly SteeringReceipt[]): void {
		if (receipts.length === 0) return;
		if (this.completedSteering.size >= MAX_RETAINED_STEERING_RUNS) {
			const oldest = this.completedSteering.keys().next().value;
			if (oldest !== undefined) this.completedSteering.delete(oldest);
		}
		this.completedSteering.set(runId, { workId, receipts });
	}

	private canSteer(
		workId: string,
		runId: string,
		role: InvocationRole,
		initial: WorkView | undefined,
		signal: AbortSignal,
	): boolean {
		const work = this.archive.project(workId);
		if (initial === undefined) return false;
		if (work === undefined) return false;
		if (signal.aborted) return false;
		return [
			this.ownsSupervision(),
			!isTerminalWork(work),
			sameMission(work, initial),
			sameExecution(work, initial),
			hasReservedRun(work, runId, role),
		].every(Boolean);
	}

	private ownsSupervision(): boolean {
		return this.options.supervision === "candidate" && this.archive.acquireSupervision();
	}

	private clearResolvedDispatchAttention(work: WorkView): void {
		if (!isDispatchBudgetAttention(work.lastError)) return;
		this.core.append({
			meta: {
				actor: "system",
				commandId: `dispatch-eligible:${work.workId}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "execution",
			workId: work.workId,
			payload: { dispatch: "eligible" },
			projection: {
				...work,
				revision: work.revision + 1,
				lastError: undefined,
				nextAction: "Work dispatch is pending.",
			},
			summary: "Work dispatch eligibility was restored.",
		});
	}

	private activeInvocationCount(): number {
		return this.archive.listProjects().reduce((total, work) => total + (work.activeInvocations?.length ?? 0), 0);
	}
}
