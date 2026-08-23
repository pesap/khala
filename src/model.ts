export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
	readonly [key: string]: JsonValue | undefined;
}

export const WORK_STATES = [
	"submitted",
	"needs-input",
	"queued",
	"active",
	"awaiting-review",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const MISSION_STATES = ["admitted", "active", "awaiting-review", "succeeded", "rejected", "superseded"] as const;
export type MissionState = (typeof MISSION_STATES)[number];

export const EXECUTION_STATES = [
	"queued",
	"running",
	"awaiting-review",
	"completed",
	"blocked",
	"failed",
	"stopped",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const RECORD_KINDS = [
	"submission",
	"assessment",
	"learning",
	"mission",
	"mission-change",
	"execution",
	"signal",
	"review-request",
	"observation",
	"delivery",
	"verdict",
	"oracle-review",
	"outcome",
	"error",
	"work-amended",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export type Actor = "user" | "conclave" | "observer" | "executor" | "oracle" | "monitor" | "system";

export type WorkBudget = Readonly<{
	maxTokens: number;
	reservedTokens: number;
	consumedTokens: number;
}>;

export type WorkTerms = Readonly<{
	title: string;
	objective: string;
	context: string;
	scope: string;
	acceptanceCriteria: readonly string[];
	constraints: readonly string[];
	validation: readonly string[];
	maxTokens: number;
}>;

export type SubmitWorkInput = Readonly<{
	workId?: string | undefined;
	title: string;
	objective: string;
	context?: string | undefined;
	scope?: string | undefined;
	acceptanceCriteria: readonly string[];
	constraints?: readonly string[] | undefined;
	validation?: readonly string[] | undefined;
	maxTokens?: number | undefined;
}>;

export type Mission = Readonly<{
	missionId: string;
	workId: string;
	assignment: WorkTerms;
	mandateRevision: number;
	createdAt: string;
	predecessorMissionId?: string | undefined;
}>;

export type PromptIdentity = Readonly<{
	packageVersion: string;
	promptSha256: string;
}>;

export type Sandbox = Readonly<{
	path: string;
	baseCommit: string;
	branch: string;
}>;

export type PiBinding = Readonly<{
	sessionId: string;
	sessionPath: string;
}>;

export type Execution = Readonly<{
	executionId: string;
	workId: string;
	missionId: string;
	state: ExecutionState;
	model: string;
	thinking: string;
	tokenAllowance: number;
	promptIdentity: PromptIdentity;
	sandbox: Sandbox;
	pi?: PiBinding | undefined;
	startedAt?: string | undefined;
	endedAt?: string | undefined;
}>;

export type ReviewRequest = Readonly<{
	provider: "github" | "gitlab";
	principalId: string;
	providerId: string;
	url: string;
	status: "draft" | "open" | "merged" | "closed";
	sourceBranch: string;
	targetBranch: string;
	headCommit: string;
	diffSummary: string;
	validation: readonly string[];
}>;

export type Signal = Readonly<{
	signalId: string;
	executionId: string;
	kind: "progress" | "blocked" | "ready";
	summary: string;
	evidence: readonly string[];
	observedAt: string;
}>;

export type ProviderObservation = Readonly<{
	observationId: string;
	kind: "ci-status" | "review-comment" | "feedback-delivery" | "monitor-failure" | "provider-outcome";
	providerId: string;
	status: string;
	summary: string;
	changed: boolean;
	observedAt: string;
}>;

export type WorkView = Readonly<{
	workId: string;
	revision: number;
	state: WorkState;
	terms: WorkTerms;
	budget: WorkBudget;
	mission?: Mission | undefined;
	missionState?: MissionState | undefined;
	execution?: Execution | undefined;
	reviewRequest?: ReviewRequest | undefined;
	lastSignal?: Signal | undefined;
	lastObservation?: ProviderObservation | undefined;
	nextAction: string;
	queuedSequence: number;
}>;

export type WorkSummary = Readonly<{
	workId: string;
	title: string;
	state: WorkState;
	revision: number;
	queuePosition?: number | undefined;
	budget: WorkBudget;
	nextAction: string;
}>;

export type CommandMeta = Readonly<{
	commandId: string;
	actor: Actor;
	expectedWorkRevision?: number | undefined;
	schemaVersion: 1;
}>;

export type RecordView = Readonly<{
	sequence: number;
	id: string;
	kind: RecordKind;
	actor: Actor;
	workId: string;
	missionId?: string | undefined;
	executionId?: string | undefined;
	payloadVersion: number;
	summary: string;
	evidenceRefs: readonly string[];
	recordedAt: string;
	payload: JsonValue;
}>;

export type Page<T> = Readonly<{
	items: readonly T[];
	nextCursor?: string | undefined;
	asOfSequence: number;
}>;

export type RecordQuery = Readonly<{
	workId?: string | undefined;
	missionId?: string | undefined;
	executionId?: string | undefined;
	kinds?: readonly RecordKind[] | undefined;
	states?: readonly string[] | undefined;
	from?: string | undefined;
	to?: string | undefined;
}>;

export type MutableRecordQuery = {
	workId?: string | undefined;
	missionId?: string | undefined;
	executionId?: string | undefined;
	kinds?: readonly RecordKind[] | undefined;
	states?: readonly string[] | undefined;
	from?: string | undefined;
	to?: string | undefined;
};

export type Action = Readonly<{
	id: string;
	scope: "work" | "mission" | "execution" | "project";
	kind:
		| "admit"
		| "launch-observer"
		| "record-assessment"
		| "start-execution"
		| "record-signal"
		| "create-review-request"
		| "run-oracle"
		| "verdict"
		| "record-review"
		| "record-outcome"
		| "cancel"
		| "amend-budget"
		| "fail-work";
	label: string;
	enabled: boolean;
	disabledReason?: string | undefined;
	confirmation?: string | undefined;
	expectedWorkRevision?: number | undefined;
}>;

export type ActionInput = Readonly<{
	kind?: string | undefined;
	summary?: string | undefined;
	evidence?: readonly string[] | undefined;
	decision?: string | undefined;
	reason?: string | undefined;
	signalId?: string | undefined;
	status?: string | undefined;
	feedback?: readonly string[] | undefined;
	subject?: string | undefined;
	maxTokens?: number | undefined;
}>;

export type ActionCommand = Readonly<{
	action: Action["kind"];
	workId: string;
	input?: ActionInput | undefined;
	meta: CommandMeta;
}>;

export type ErrorEnvelope = Readonly<{
	code:
		| "invalid-input"
		| "not-found"
		| "forbidden"
		| "revision-conflict"
		| "invalid-state"
		| "budget-exhausted"
		| "external-failure"
		| "integrity-failure";
	summary: string;
	retryable: boolean;
	remediation: string;
	evidenceRefs: readonly string[];
}>;

export type ServiceResult<T> = Readonly<{ value: T }> | Readonly<{ error: ErrorEnvelope }>;

export function isServiceError<T>(result: ServiceResult<T>): result is Readonly<{ error: ErrorEnvelope }> {
	return "error" in result;
}

export function assertNonBlank(value: string, field: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new Error(`${field} must not be blank.`);
	}
	return normalized;
}

export function assertPositiveInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer.`);
	}
	return value;
}

export function cloneJson<T extends JsonValue>(value: T): T {
	// SAFETY: JSON serialization preserves the JsonValue shape and creates a detached copy.
	return JSON.parse(JSON.stringify(value)) as T;
}
