export type ArchiveEffect = Readonly<{
	effectId: string;
	kind: string;
	payload: JsonObject;
}>;

export type ArchiveAppend = Readonly<{
	commandId: string;
	commandFingerprint?: string | undefined;
	expectedWorkRevision: number;
	kind: RecordKind;
	actor: Actor;
	workId: string;
	missionId?: string | undefined;
	executionId?: string | undefined;
	payloadVersion: number;
	summary: string;
	evidenceRefs?: readonly string[] | undefined;
	payload: JsonValue;
	projection: WorkView;
	effects?: readonly ArchiveEffect[] | undefined;
	executionGuard?: Readonly<{ maxConcurrentExecutions: number; enforceFifo?: boolean }> | undefined;
	invocationLimit?: number | undefined;
}>;

export class InvocationCapacityExceeded extends Error {
	constructor() {
		super("The total model invocation limit is occupied; wait for settlement or explicit reconciliation.");
		this.name = "InvocationCapacityExceeded";
	}
}

export type ArchiveAppendResult = Readonly<{
	record: RecordView;
	projection: WorkView;
	duplicate: boolean;
}>;

export type PendingArchiveEffect = Readonly<{
	effectId: string;
	kind: string;
	payload: JsonObject;
	createdAt: string;
}>;

export interface ArchivePort {
	append: (input: ArchiveAppend) => ArchiveAppendResult;
	updateCommandProjection: (commandId: string, projection: WorkView) => void;
	findCommand: (commandId: string, commandFingerprint?: string) => ArchiveAppendResult | undefined;
	findInvocation: (runId: string) => ArchiveAppendResult | undefined;
	countPendingInvocations: () => number;
	pendingEffects: (owner?: string, excludedEffectIds?: readonly string[]) => readonly PendingArchiveEffect[];
	completeEffect: (effectId: string, owner?: string) => boolean;
	releaseEffect: (effectId: string, owner?: string) => void;
	renewEffect: (effectId: string, owner?: string) => boolean;
	query: (query?: RecordQuery, cursor?: string) => Page<RecordView>;
	querySummaries: (query?: RecordQuery, visibleExecutionId?: string) => Page<RecordSummaryView>;
	project: (workId: string) => WorkView | undefined;
	findObservation: (workId: string, observationId: string) => ProviderObservation | undefined;
	findLatestObservation: (
		workId: string,
		kind: ProviderObservation["kind"],
		providerId: string,
		observationId?: string | undefined,
	) => ProviderObservation | undefined;
	listProjects: () => readonly WorkView[];
	acquireSupervision: () => boolean;
	releaseSupervision: () => void;
	close: () => void;
}
export type SQLiteArchiveOptions = Readonly<{ readOnly?: boolean | undefined }>;
export class CommandReuseConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandReuseConflict";
	}
}

export class ExecutionAdmissionConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionAdmissionConflict";
	}
}

export class RevisionConflict extends Error {
	readonly workId: string;
	readonly expected: number;
	readonly actual: number;

	constructor(workId: string, expected: number, actual: number) {
		super(`Work ${workId} revision conflict: expected ${expected}, found ${actual}.`);
		this.name = "RevisionConflict";
		this.workId = workId;
		this.expected = expected;
		this.actual = actual;
	}
}

import type {
	Actor,
	JsonObject,
	JsonValue,
	Page,
	ProviderObservation,
	RecordKind,
	RecordQuery,
	RecordSummaryView,
	RecordView,
	WorkView,
} from "./model.js";
