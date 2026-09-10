import type { ArchivePort } from "./archive.js";
import { dispatchInvocation, type InvocationSender } from "./dispatch.js";
import type { TokenUsage, WorkView } from "./model.js";
import type { OperationContext } from "./ports.js";
import type { InvocationRole, RunLedger } from "./run-ledger.js";
import { ArchiveCore } from "./service-archive-core.js";
import { RunGateUnavailable, type ServiceOptions } from "./service-contracts.js";
import { workMaxConcurrentRuns } from "./service-runtime-policy.js";
import { isDispatchBudgetAttention } from "./service-state-policy.js";
import { DispatchEligibilityError, dispatchEligibility } from "./workflow-dispatch.js";

type GovernedInvocationSender<T extends { usage?: TokenUsage | undefined }> = (
	reservation: Parameters<InvocationSender<T>>[0],
	operation: OperationContext,
) => Promise<T>;

export class InvocationCoordinator {
	private readonly activeInvocations = new Map<
		string,
		Readonly<{ workId: string; role: InvocationRole; controller: AbortController }>
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
		this.activeInvocations.set(reservation.runId, { workId, role, controller });
		try {
			return await send(reservation, { signal: controller.signal });
		} finally {
			this.activeInvocations.delete(reservation.runId);
		}
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
