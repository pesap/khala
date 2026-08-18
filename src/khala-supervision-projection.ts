// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: The monitor projection keeps independently sourced factual states together.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Bounded monitor facts are assembled in one projection pass.
// biome-ignore-all lint/style/noTernary: Optional monitor fields are explicit and fail closed.
// biome-ignore-all lint/style/noMagicNumbers: Display abbreviations and bounded projection values are local constants.
// biome-ignore-all lint/style/noContinue: Archive and session projections use fail-closed filtering.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: This projection is the bounded read-model boundary for the existing monitor.
// biome-ignore-all lint/style/useBlockStatements: Defensive record filtering stays visually compact in this read-only projection.
// biome-ignore-all lint/complexity/useMaxParams: The action projection receives independently sourced facts explicitly.
// biome-ignore-all lint/complexity/noUselessUndefined: Optional monitor evidence is returned explicitly at the projection boundary.
// biome-ignore-all lint/style/useDestructuring: Defensive untrusted Archive reads retain their source field names.
// biome-ignore-all lint/complexity/useSimplifiedLogicExpression: Explicit target matching keeps Execution and Work scope visible.
// biome-ignore-all lint/style/useForOf: Ordered custom-entry scans retain bounded projection order.
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
	type CoordinationRecord,
	type ExecutorRecord,
	isCoordinationRecord,
	isVerdict,
	type KhalaArchiveRecord,
	type MissionRecord,
	type SignalRecord,
	type UpstreamExecutionBase,
	type VerdictRecord,
} from "./khala-model.js";

const SUPERVISION_ENTRY_TYPES = {
	budget: "khala-supervision-budget",
	critical: "khala-supervision-critical-event",
	outage: "khala-supervision-outage",
	actionStart: "khala-supervision-action-start",
	actionComplete: "khala-supervision-action-complete",
} as const;

const CONCLAVE_MONITOR_ENTRY_TYPES: ReadonlySet<string> = new Set([
	SUPERVISION_ENTRY_TYPES.budget,
	SUPERVISION_ENTRY_TYPES.critical,
	SUPERVISION_ENTRY_TYPES.outage,
	SUPERVISION_ENTRY_TYPES.actionStart,
	SUPERVISION_ENTRY_TYPES.actionComplete,
	"khala-supervision-critical",
]);

type SupervisionRuntimeState = "starting" | "running" | "finished" | "failed" | "unavailable";
type SupervisionConnectionState = "connected" | "unavailable" | "recovering" | "settled";
type CostObservation = Readonly<{
	thresholdUsd?: number | undefined;
	costUsd?: number | undefined;
	overrun: boolean;
}>;
type SteerMonitorFact = Readonly<{
	status: "persisted" | "failed";
	mode: string;
	category?: string;
	missionTerm?: string;
	message?: string;
	abort: "confirmed" | "not-applicable" | "unavailable";
	prompt: "persisted" | "failed" | "unavailable";
	outcome?: string;
	outcomeReason?: string;
	observedEntryIds: readonly string[];
}>;
type CoordinationMonitorFact = Readonly<{
	relation: string;
	phase: string;
	selectedWorkId: string;
	selectedReason: string;
	stoppedWorkId?: string;
	delayedWorkId?: string;
	requiredUpstreamCommit?: string;
	invalidatedWorkIds: readonly string[];
	terminalSchedulingFailure: boolean;
}>;
type LatestSignificantAction = Readonly<{
	kind: "steer" | "coordination" | "lifecycle" | "failure" | "budget";
	summary: string;
	details: readonly string[];
	observedAt?: string;
}>;
type UpstreamMonitorFact = Readonly<
	UpstreamExecutionBase & {
		stale: boolean;
		invalidationReason?: string;
	}
>;
type KhalaExecutionMonitor = Readonly<{
	runtimeState: SupervisionRuntimeState;
	supervisionState: SupervisionConnectionState;
	incomplete: boolean;
	latestSignificantAction?: LatestSignificantAction;
	steer?: SteerMonitorFact;
	coordination?: CoordinationMonitorFact;
	upstream?: UpstreamMonitorFact;
	models: Readonly<{ conclave: string; executor: string }>;
	thresholds: Readonly<{ conclaveUsd?: number | undefined; executorUsd?: number | undefined }>;
	latestTurnCost: Readonly<{ conclave: CostObservation; executor: CostObservation }>;
	grace?: Readonly<{ failedCheckCount: number; deadlineAt: string; kind: string }>;
}>;

type SupervisionProjectionInput = Readonly<{
	execution: ExecutorRecord;
	runtimeAvailable: boolean;
	workTitle: string;
	missions: readonly MissionRecord[];
	signals: readonly SignalRecord[];
	archiveRecords: readonly KhalaArchiveRecord[];
	conclaveEntries: readonly FileEntry[];
	config: Readonly<{
		conclaveModel: string;
		executorModel: string;
		conclaveMaxCostUsdPerTurn: number;
		executorMaxCostUsdPerTurn: number;
	}>;
}>;

type RecordWithPayload<T> = Readonly<{ record: KhalaArchiveRecord; payload: T }>;

function projectExecutionMonitor(input: SupervisionProjectionInput): KhalaExecutionMonitor {
	const { execution } = input;
	const mission = input.missions.find((candidate) => candidate.missionId === execution.missionId);
	const workBudget = mission?.assignment.costBudget;
	let conclaveThreshold: number | undefined;
	if (positiveNumber(workBudget?.conclaveMaxCostUsdPerTurn)) {
		conclaveThreshold = workBudget.conclaveMaxCostUsdPerTurn;
	} else if (positiveNumber(input.config.conclaveMaxCostUsdPerTurn)) {
		conclaveThreshold = input.config.conclaveMaxCostUsdPerTurn;
	}
	let executorThreshold: number | undefined;
	if (positiveNumber(workBudget?.executorMaxCostUsdPerTurn)) {
		executorThreshold = workBudget.executorMaxCostUsdPerTurn;
	} else if (positiveNumber(input.config.executorMaxCostUsdPerTurn)) {
		executorThreshold = input.config.executorMaxCostUsdPerTurn;
	}
	const budgets = readBudgetObservations(input.conclaveEntries, execution.executionId);
	const latestConclaveBudget = latestBudget(budgets, "conclave");
	const latestExecutorBudget = latestBudget(budgets, "executor");
	const executorOverrun = budgets.some((budget) => budget.actor === "executor" && budget.overrun);
	const conclaveOverrun = budgets.some((budget) => budget.actor === "conclave" && budget.overrun);
	const latestOverrun = budgets.filter((budget) => budget.overrun).at(-1);
	const outage = latestRelevantOutage(input.conclaveEntries, execution);
	const runtimeState =
		(execution.status === "starting" || execution.status === "running") && !input.runtimeAvailable
			? "unavailable"
			: execution.status;
	const supervisionState = getSupervisionState(runtimeState, outage);
	const relatedSignals = input.signals.filter(
		(signal) => signal.executionId === execution.executionId && signal.workId === execution.workId,
	);
	const relatedVerdicts = input.archiveRecords.flatMap((record) => {
		if (record.type !== "verdict" || !isVerdict(record.payload)) {
			return [];
		}
		if (record.payload.executionId !== execution.executionId || record.payload.workId !== execution.workId) {
			return [];
		}
		return [{ record, payload: record.payload } satisfies RecordWithPayload<VerdictRecord>];
	});
	const stale = readStaleUpstream(input.archiveRecords, execution.upstreamBase);
	const latestCoordination = latestCoordinationForExecution(input.archiveRecords, execution);
	const latestIntervention = latestInterventionForExecution(input.archiveRecords, execution);
	const failedAction = readFailedAction(input.conclaveEntries, input.archiveRecords, execution);
	const criticalFailure = latestCriticalFailure(input.conclaveEntries, execution);
	const steer = failedAction ?? (latestIntervention === undefined ? undefined : toSteerFact(latestIntervention));
	const coordination =
		latestCoordination === undefined
			? undefined
			: toCoordinationFact(latestCoordination, execution.upstreamBase?.headCommit);
	const latestAction = latestActionForExecution(
		input,
		latestCoordination,
		latestIntervention,
		relatedVerdicts,
		failedAction,
		criticalFailure,
		outage,
		latestOverrun,
	);
	const incomplete =
		(execution.status === "finished" || execution.status === "failed") &&
		relatedSignals.length === 0 &&
		relatedVerdicts.length === 0;
	return {
		runtimeState,
		supervisionState,
		incomplete,
		...(latestAction === undefined ? {} : { latestSignificantAction: latestAction }),
		...(steer === undefined ? {} : { steer }),
		...(coordination === undefined ? {} : { coordination }),
		...(execution.upstreamBase === undefined
			? {}
			: {
					upstream: {
						...execution.upstreamBase,
						stale,
						...(stale ? { invalidationReason: "An upstream revision invalidated this retained base." } : {}),
					},
				}),
		models: {
			conclave: nonblank(input.config.conclaveModel),
			executor: nonblank(input.config.executorModel),
		},
		thresholds: { conclaveUsd: conclaveThreshold, executorUsd: executorThreshold },
		latestTurnCost: {
			executor: {
				...(latestExecutorBudget?.thresholdUsd === undefined
					? {}
					: { thresholdUsd: latestExecutorBudget.thresholdUsd }),
				...(latestExecutorBudget?.costUsd === undefined ? {} : { costUsd: latestExecutorBudget.costUsd }),
				overrun: executorOverrun,
			},
			conclave: {
				...(latestConclaveBudget?.thresholdUsd === undefined
					? {}
					: { thresholdUsd: latestConclaveBudget.thresholdUsd }),
				...(latestConclaveBudget?.costUsd === undefined ? {} : { costUsd: latestConclaveBudget.costUsd }),
				overrun: conclaveOverrun,
			},
		},
		...(outage === undefined
			? {}
			: {
					grace: {
						failedCheckCount: outage.failedCheckCount,
						deadlineAt: outage.deadlineAt,
						kind: outage.kind,
					},
				}),
	};
}

function getSupervisionState(
	runtimeState: SupervisionRuntimeState,
	outage: OutageFact | undefined,
): SupervisionConnectionState {
	if (runtimeState === "finished" || runtimeState === "failed") {
		return "settled";
	}
	if (runtimeState === "unavailable") {
		return "unavailable";
	}
	if (outage === undefined) {
		return "connected";
	}
	if (outage.state === "open" && outage.failedCheckCount > 0) {
		return "recovering";
	}
	return "unavailable";
}

type MonitorData = Readonly<{
	state?: unknown;
	executionIds?: unknown;
	workIds?: unknown;
	kind?: unknown;
	failedCheckCount?: unknown;
	deadlineAt?: unknown;
	executionId?: unknown;
	actor?: unknown;
	costUsd?: unknown;
	thresholdUsd?: unknown;
	overrun?: unknown;
	interventionId?: unknown;
	phase?: unknown;
	actionId?: unknown;
	target?: unknown;
	actionKind?: unknown;
	mode?: unknown;
	workId?: unknown;
	reason?: unknown;
	error?: unknown;
	missionId?: unknown;
}> &
	Readonly<Record<string, unknown>>;

type CriticalFailureFact = Readonly<{
	reason: string;
	observedAt: string;
}>;

type OutageFact = Readonly<{
	kind: string;
	state: "open" | "failed";
	failedCheckCount: number;
	deadlineAt: string;
	observedAt: string;
}>;

function latestRelevantOutage(entries: readonly FileEntry[], execution: ExecutorRecord): OutageFact | undefined {
	let latest: OutageFact | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUPERVISION_ENTRY_TYPES.outage) {
			continue;
		}
		const data = recordData(entry);
		if (!isRecord(data) || (data.state !== "open" && data.state !== "failed")) {
			continue;
		}
		const executionIds = stringArray(data.executionIds);
		const workIds = stringArray(data.workIds);
		if (
			data.kind !== "conclave-model" &&
			!executionIds.includes(execution.executionId) &&
			!workIds.includes(execution.workId)
		) {
			continue;
		}
		if (
			typeof data.failedCheckCount !== "number" ||
			!Number.isInteger(data.failedCheckCount) ||
			data.failedCheckCount < 0 ||
			typeof data.deadlineAt !== "string"
		) {
			continue;
		}
		latest = {
			kind: typeof data.kind === "string" ? data.kind : "supervision",
			state: data.state,
			failedCheckCount: data.failedCheckCount,
			deadlineAt: data.deadlineAt,
			observedAt: entryTimestamp(entry),
		};
	}
	return latest;
}

function latestCriticalFailure(
	entries: readonly FileEntry[],
	execution: ExecutorRecord,
): CriticalFailureFact | undefined {
	let latest: CriticalFailureFact | undefined;
	for (const entry of entries) {
		if (entry === undefined || (entry.type !== "custom" && entry.type !== "custom_message")) {
			continue;
		}
		if (entry.customType !== SUPERVISION_ENTRY_TYPES.critical && entry.customType !== "khala-supervision-critical") {
			continue;
		}
		const data = recordData(entry);
		if (!isRecord(data)) {
			continue;
		}
		const targetsExecution = data.executionId === execution.executionId;
		const targetsWork = data.workId === execution.workId;
		if (!targetsExecution && !targetsWork) {
			continue;
		}
		let reason = "Runtime failure evidence unavailable.";
		if (typeof data.reason === "string") {
			reason = data.reason;
		} else if (typeof data.error === "string") {
			reason = data.error;
		}
		latest = { reason, observedAt: entryTimestamp(entry) };
	}
	return latest;
}

function readBudgetObservations(entries: readonly FileEntry[], executionId: string): BudgetObservation[] {
	const result: BudgetObservation[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUPERVISION_ENTRY_TYPES.budget) {
			continue;
		}
		const data = recordData(entry);
		if (
			!isRecord(data) ||
			data.executionId !== executionId ||
			(data.actor !== "executor" && data.actor !== "conclave")
		) {
			continue;
		}
		const costUsd = positiveNumber(data.costUsd) ? data.costUsd : undefined;
		const thresholdUsd = positiveNumber(data.thresholdUsd) ? data.thresholdUsd : undefined;
		result.push({
			actor: data.actor,
			costUsd,
			thresholdUsd,
			overrun: data.overrun === true,
			observedAt: entryTimestamp(entry),
		});
	}
	return result;
}

type BudgetObservation = Readonly<CostObservation & { actor: "executor" | "conclave"; observedAt: string }>;

function latestBudget(
	observations: readonly BudgetObservation[],
	actor: BudgetObservation["actor"],
): BudgetObservation | undefined {
	return observations.filter((observation) => observation.actor === actor).at(-1);
}

function latestCoordinationForExecution(
	records: readonly KhalaArchiveRecord[],
	execution: ExecutorRecord,
): CoordinationRecord | undefined {
	return records
		.flatMap((record) => {
			if (record.type !== "coordination" || !isCoordinationRecord(record.payload)) {
				return [];
			}
			const coordination = record.payload;
			const related =
				coordination.executionId === execution.executionId ||
				coordination.relatedExecutionId === execution.executionId ||
				coordination.selectedExecutionId === execution.executionId ||
				coordination.workId === execution.workId ||
				coordination.relatedWorkId === execution.workId;
			return related ? [coordination] : [];
		})
		.at(-1);
}

type InterventionEnvelope = Readonly<{
	issuance: RecordWithPayload<InterventionPayload>;
	outcome?: RecordWithPayload<InterventionPayload>;
}>;
type InterventionPayload = Readonly<Record<string, unknown>> & {
	interventionId: string;
	executionId: string;
	phase: "issuance" | "outcome";
	mode?: string;
	category?: string;
	missionTerm?: string;
	message?: string;
	outcome?: string;
	reason?: string;
	observedEntryIds?: readonly string[];
	piEntryIds?: readonly string[];
};

function latestInterventionForExecution(
	records: readonly KhalaArchiveRecord[],
	execution: ExecutorRecord,
): InterventionEnvelope | undefined {
	const groups = new Map<string, InterventionEnvelope>();
	for (const record of records) {
		if (record.type !== "intervention" || !isRecord(record.payload)) {
			continue;
		}
		const payload = record.payload as InterventionPayload;
		if (
			typeof payload.interventionId !== "string" ||
			(payload.phase !== "issuance" && payload.phase !== "outcome") ||
			payload.executionId !== execution.executionId
		) {
			continue;
		}
		const current = groups.get(payload.interventionId);
		if (payload.phase === "issuance") {
			groups.set(payload.interventionId, { issuance: { record, payload } });
		} else if (current !== undefined) {
			groups.set(payload.interventionId, { ...current, outcome: { record, payload } });
		}
	}
	return [...groups.values()].at(-1);
}

function toSteerFact(intervention: InterventionEnvelope): SteerMonitorFact {
	const issuance = intervention.issuance.payload;
	const outcome = intervention.outcome?.payload;
	return {
		status: "persisted",
		mode: typeof issuance.mode === "string" ? issuance.mode : "correction",
		...(typeof issuance.category === "string" ? { category: issuance.category } : {}),
		...(typeof issuance.missionTerm === "string" ? { missionTerm: issuance.missionTerm } : {}),
		...(typeof issuance.message === "string" ? { message: issuance.message } : {}),
		abort: issuance.mode === "stop" ? "confirmed" : "not-applicable",
		prompt: "persisted",
		...(typeof outcome?.outcome === "string" ? { outcome: outcome.outcome } : {}),
		...(typeof outcome?.reason === "string" ? { outcomeReason: outcome.reason } : {}),
		observedEntryIds: stringArray(issuance.piEntryIds ?? outcome?.observedEntryIds),
	};
}

function readFailedAction(
	entries: readonly FileEntry[],
	records: readonly KhalaArchiveRecord[],
	execution: ExecutorRecord,
): SteerMonitorFact | undefined {
	let latest: SteerMonitorFact | undefined;
	const completed = new Set(
		records.flatMap((record) => {
			if (record.type !== "intervention" || !isRecord(record.payload)) return [];
			const actionId = record.payload.actionId;
			return typeof actionId === "string" ? [actionId] : [];
		}),
	);
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUPERVISION_ENTRY_TYPES.actionStart) continue;
		const data = recordData(entry);
		if (!(isRecord(data) && isRecord(data.target)) || data.target.executionId !== execution.executionId) continue;
		if (typeof data.actionId !== "string" || completed.has(data.actionId)) continue;
		if (data.actionKind !== "steer" && data.actionKind !== "stop") continue;
		latest = {
			status: "failed",
			mode: typeof data.mode === "string" ? data.mode : "correction",
			abort: data.actionKind === "stop" ? "unavailable" : "not-applicable",
			prompt: "failed",
			observedEntryIds: [],
		};
	}
	return latest;
}

function toCoordinationFact(
	coordination: CoordinationRecord,
	retainedUpstreamCommit: string | undefined,
): CoordinationMonitorFact {
	const requiredUpstreamCommit = coordination.upstreamHead ?? retainedUpstreamCommit;
	const invalidatedWorkIds = coordination.affectedDependents?.map((dependent) => dependent.workId) ?? [];
	const terminalSchedulingFailure =
		coordination.phase === "resolution" && coordination.resolution === "terminal-failure";
	let stoppedWorkId: string | undefined;
	let delayedWorkId: string | undefined;
	if (coordination.relation === "dependency") {
		delayedWorkId = coordination.workId;
		stoppedWorkId = coordination.executionId === undefined ? undefined : coordination.workId;
	} else if (coordination.selectedWorkId !== coordination.workId) {
		stoppedWorkId = coordination.workId;
	}
	return {
		relation: coordination.relation,
		phase: coordination.phase,
		selectedWorkId: coordination.selectedWorkId,
		selectedReason: coordination.reason,
		...(stoppedWorkId === undefined ? {} : { stoppedWorkId }),
		...(delayedWorkId === undefined ? {} : { delayedWorkId }),
		...(requiredUpstreamCommit === undefined ? {} : { requiredUpstreamCommit }),
		invalidatedWorkIds,
		terminalSchedulingFailure,
	};
}

function readStaleUpstream(records: readonly KhalaArchiveRecord[], base: UpstreamExecutionBase | undefined): boolean {
	if (base === undefined) return false;
	return records.some((record) => {
		if (record.type !== "coordination" || !isCoordinationRecord(record.payload)) {
			return false;
		}
		const coordination = record.payload;
		if (coordination.phase !== "invalidation" || coordination.upstreamHead !== base.headCommit) {
			return false;
		}
		return (
			coordination.affectedDependents?.some(
				(dependent) =>
					dependent.workId === base.workId ||
					dependent.workId === coordination.workId ||
					(dependent.executionId !== undefined && dependent.executionId === base.executionId),
			) === true
		);
	});
}

function latestActionForExecution(
	input: SupervisionProjectionInput,
	coordination: CoordinationRecord | undefined,
	intervention: InterventionEnvelope | undefined,
	verdicts: readonly RecordWithPayload<VerdictRecord>[],
	failedSteer: SteerMonitorFact | undefined,
	criticalFailure: CriticalFailureFact | undefined,
	outage: OutageFact | undefined,
	budget: BudgetObservation | undefined,
): LatestSignificantAction | undefined {
	const candidates: Array<LatestSignificantAction & { order: number }> = [];
	if (coordination !== undefined) {
		candidates.push({
			kind: "coordination",
			summary: `Coordination ${coordination.phase}: ${coordination.relation}.`,
			details: [coordination.reason, "Override by speaking in the Conclave session."],
			order: lastArchivePayloadIndex(input.archiveRecords, coordination),
		});
	}
	if (intervention !== undefined) {
		const payload = intervention.outcome?.payload ?? intervention.issuance.payload;
		candidates.push({
			kind: "steer",
			summary: `Steer ${intervention.outcome === undefined ? "persisted" : `outcome ${payload.outcome ?? "observed"}`}.`,
			details: [
				typeof payload.message === "string" ? payload.message : "Bounded steer message unavailable.",
				...(payload.reason === undefined ? [] : [`Observed outcome: ${payload.reason}`]),
			],
			order: lastArchivePayloadIndex(input.archiveRecords, payload),
		});
	}
	const verdict = verdicts.at(-1);
	if (verdict !== undefined) {
		candidates.push({
			kind: "lifecycle",
			summary: `Lifecycle Verdict: ${verdict.payload.decision}.`,
			details: [verdict.payload.reason],
			observedAt: verdict.record.recordedAt,
			order: input.archiveRecords.indexOf(verdict.record),
		});
	}
	if (failedSteer !== undefined && failedSteer.status === "failed") {
		candidates.push({
			kind: "failure",
			summary: "Steer delivery failed; no persisted Intervention issuance.",
			details: ["The failed steer remains failed."],
			order: input.conclaveEntries.length + 1,
		});
	}
	if (criticalFailure !== undefined) {
		candidates.push({
			kind: "failure",
			summary: "Executor runtime or supervision process failure.",
			details: [criticalFailure.reason, "Executor runtime state and supervision state remain separate."],
			observedAt: criticalFailure.observedAt,
			order: input.conclaveEntries.length + 1,
		});
	}
	if (outage !== undefined) {
		candidates.push({
			kind: "failure",
			summary: `Supervision ${outage.state === "failed" ? "fail-safe" : "unavailable"}.`,
			details: [`${outage.kind} check count: ${outage.failedCheckCount}.`],
			observedAt: outage.observedAt,
			order: input.conclaveEntries.length + 2,
		});
	}
	if (budget?.overrun === true) {
		candidates.push({
			kind: "budget",
			summary: `Advisory ${budget.actor} budget overrun; work continues.`,
			details: ["No automatic model change or lifecycle action was inferred."],
			observedAt: budget.observedAt,
			order: input.conclaveEntries.length + 3,
		});
	}
	return candidates.sort((left, right) => left.order - right.order).at(-1);
}

function lastArchivePayloadIndex(records: readonly KhalaArchiveRecord[], payload: unknown): number {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		if (records[index]?.payload === payload) {
			return index;
		}
	}
	return -1;
}

function recordData(entry: FileEntry): unknown {
	if (entry.type === "custom") return entry.data;
	if (entry.type === "custom_message") return entry.details;
	return undefined;
}

function entryTimestamp(entry: FileEntry): string {
	return typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
}

function isRecord(value: unknown): value is MonitorData {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((candidate): candidate is string => typeof candidate === "string") : [];
}

function positiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonblank(value: string): string {
	return value.trim().length > 0 ? value : "unavailable";
}

export type {
	CoordinationMonitorFact,
	CostObservation,
	KhalaExecutionMonitor,
	LatestSignificantAction,
	SteerMonitorFact,
	SupervisionConnectionState,
	SupervisionProjectionInput,
	SupervisionRuntimeState,
	UpstreamMonitorFact,
};
export { CONCLAVE_MONITOR_ENTRY_TYPES, projectExecutionMonitor };
