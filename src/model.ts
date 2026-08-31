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
	"stopped",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const WORK_STOP_REASONS = ["failed", "cancelled"] as const;
export type WorkStopReason = (typeof WORK_STOP_REASONS)[number];

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

export const EXECUTION_RUNTIME_STATES = ["working", "idle", "pending", "unreachable", "unknown"] as const;
export type ExecutionRuntimeState = (typeof EXECUTION_RUNTIME_STATES)[number];

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
	"validation",
	"work-amended",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const ACTORS = ["user", "conclave", "observer", "executor", "oracle", "monitor", "system"] as const;
export type Actor = (typeof ACTORS)[number];

export function parseRecordKind(value: string): RecordKind {
	const kind = RECORD_KINDS.find((candidate) => candidate === value);
	if (kind === undefined) throw new Error(`Record kind ${value} is invalid.`);
	return kind;
}

export function isActor(value: string): value is Actor {
	// SAFETY: the cast only adapts the broad input to the literal-union argument required by includes.
	return ACTORS.includes(value as Actor);
}

export const GOVERNED_ROLES = ["conclave", "executor", "observer", "oracle"] as const;
export type GovernedRole = (typeof GOVERNED_ROLES)[number];
export type RoleSetting = "model" | "thinking";
export type RoleSettings = Readonly<{ model: string; thinking: string }>;
export type RoleSettingsMap = Readonly<Record<GovernedRole, RoleSettings>>;

export type WorkBudget = Readonly<{
	maxTokens: number;
	reservedTokens: number;
	consumedTokens: number;
}>;

export type TokenUsage = Readonly<{
	inputTokens: number;
	outputTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
}>;

export type RecoveryUpdate = Readonly<{
	stage: "checking" | "stopping" | "restoring" | "confirming" | "finishing";
	message: string;
}>;

export type WorkTerms = Readonly<{
	title: string;
	objective: string;
	context: string;
	scope: string;
	acceptanceCriteria: readonly string[];
	constraints: readonly string[];
	validation: readonly string[];
	allowedPaths: readonly string[];
	maxTokens: number;
}>;

export type MissionSpecificity = Readonly<{
	status: "explicit" | "defaults-used";
	missing: readonly string[];
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
	allowedPaths?: readonly string[] | undefined;
	maxTokens?: number | undefined;
}>;

export type Mission = Readonly<{
	missionId: string;
	workId: string;
	assignment: WorkTerms;
	specificity?: MissionSpecificity | undefined;
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
	promptIdentity?: PromptIdentity | undefined;
	processGroupId?: number | undefined;
	processStartTime?: string | undefined;
	capabilityNonce?: string | undefined;
	processMarker?: string | undefined;
}>;

export type Execution = Readonly<{
	executionId: string;
	workId: string;
	missionId: string;
	state: ExecutionState;
	blockReason?: "signal" | "budget-exhausted" | undefined;
	runtimeState?: ExecutionRuntimeState | undefined;
	usage?: TokenUsage | undefined;
	model: string;
	thinking: string;
	tokenAllowance: number;
	promptIdentity: PromptIdentity;
	sandbox: Sandbox;
	pi?: PiBinding | undefined;
	startedAt?: string | undefined;
	endedAt?: string | undefined;
}>;

export const REVIEW_REQUEST_STATUSES = ["draft", "open", "merged", "closed"] as const;
export type ReviewRequestStatus = (typeof REVIEW_REQUEST_STATUSES)[number];

export type ReviewRequest = Readonly<{
	provider: "github" | "gitlab";
	principalId: string;
	providerId: string;
	url: string;
	repository: string;
	status: ReviewRequestStatus;
	sourceBranch: string;
	targetBranch: string;
	baseCommit?: string | undefined;
	headCommit: string;
	diffSummary: string;
	validation: readonly string[];
}>;

export type ValidationResult = Readonly<{
	command: string;
	passed: boolean;
	output: string;
}>;

export type ValidationRun = Readonly<{
	executionId: string;
	headCommit: string;
	results: readonly ValidationResult[];
}>;

export type Signal = Readonly<{
	signalId: string;
	executionId: string;
	kind: "progress" | "blocked" | "ready";
	summary: string;
	evidence: readonly string[];
	observedAt: string;
}>;

export type ProviderReviewComment = Readonly<{
	id: string;
	author?: string | undefined;
	authorAssociation?: string | undefined;
	body: string;
	createdAt?: string | undefined;
	url?: string | undefined;
	state?: string | undefined;
	source?: "issue-comment" | "review" | "inline" | undefined;
	location?: string | undefined;
	minimized?: boolean | undefined;
}>;

export type ProviderCheck = Readonly<{
	kind: "check-run" | "status-context";
	name: string;
	status: string;
	conclusion?: string | undefined;
	workflowName?: string | undefined;
	detailsUrl?: string | undefined;
	startedAt?: string | undefined;
	completedAt?: string | undefined;
}>;

export type ProviderObservationDetails = Readonly<{
	pullRequest: Readonly<{
		url: string;
		status: ReviewRequest["status"];
		state: string;
		reviewDecision: string;
		mergedAt: string | null;
	}>;
	comments: readonly ProviderReviewComment[];
	checks: readonly ProviderCheck[];
}>;

export const PROVIDER_CI_STATUSES = [...REVIEW_REQUEST_STATUSES, "checks-failed"] as const;
export type ProviderCiStatus = (typeof PROVIDER_CI_STATUSES)[number];
export const PROVIDER_REVIEW_COMMENT_STATUSES = ["changes-requested", "commented"] as const;
export type ProviderReviewCommentStatus = (typeof PROVIDER_REVIEW_COMMENT_STATUSES)[number];
export const PROVIDER_FEEDBACK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type ProviderFeedbackDeliveryStatus = (typeof PROVIDER_FEEDBACK_DELIVERY_STATUSES)[number];
export const PROVIDER_MONITOR_STATUSES = ["recovered"] as const;
export type ProviderMonitorStatus = (typeof PROVIDER_MONITOR_STATUSES)[number];

export type ProviderObservationBase = Readonly<{
	observationId: string;
	providerId: string;
	summary: string;
	changed: boolean;
	observedAt: string;
	feedback?: readonly string[] | undefined;
	author?: string | undefined;
	authorAssociation?: string | undefined;
	reviewState?: string | undefined;
	actionable?: boolean | undefined;
	repository?: string | undefined;
	sourceBranch?: string | undefined;
	targetBranch?: string | undefined;
	baseCommit?: string | undefined;
	headCommit?: string | undefined;
	mergeCommit?: string | undefined;
	details?: ProviderObservationDetails | undefined;
}>;

export type ProviderCiObservation = ProviderObservationBase &
	Readonly<{
		kind: "ci-status";
		status: ProviderCiStatus;
	}>;

export type ProviderReviewCommentObservation = ProviderObservationBase &
	Readonly<{
		kind: "review-comment";
		status: ProviderReviewCommentStatus;
	}>;

export type ProviderFeedbackDeliveryObservation = ProviderObservationBase &
	Readonly<{
		kind: "feedback-delivery";
		status: ProviderFeedbackDeliveryStatus;
	}>;

export type ProviderMonitorFailureObservation = ProviderObservationBase &
	Readonly<{
		kind: "monitor-failure";
		status: ProviderMonitorStatus;
	}>;

export type ProviderOutcomeObservation = ProviderObservationBase &
	Readonly<{
		kind: "provider-outcome";
		status: "merged";
		repository: string;
		sourceBranch: string;
		targetBranch: string;
		headCommit: string;
		mergeCommit: string;
	}>;

export type ProviderObservation =
	| ProviderCiObservation
	| ProviderReviewCommentObservation
	| ProviderFeedbackDeliveryObservation
	| ProviderMonitorFailureObservation
	| ProviderOutcomeObservation;

export type WorkView = Readonly<{
	workId: string;
	revision: number;
	state: WorkState;
	stopReason?: WorkStopReason | undefined;
	terms: WorkTerms;
	budget: WorkBudget;
	missionSpecificity?: MissionSpecificity | undefined;
	mission?: Mission | undefined;
	missionState?: MissionState | undefined;
	execution?: Execution | undefined;
	observer?: PiBinding | undefined;
	observerInFlight?: boolean | undefined;
	reviewRequest?: ReviewRequest | undefined;
	lastSignal?: Signal | undefined;
	lastObservation?: ProviderObservation | undefined;
	providerOutcome?: ProviderOutcomeObservation | undefined;
	lastValidation?: ValidationRun | undefined;
	lastError?: ErrorEnvelope | undefined;
	nextAction: string;
	queuedSequence: number;
}>;

export type WorkSummary = Readonly<{
	workId: string;
	title: string;
	state: WorkState;
	stopReason?: WorkStopReason | undefined;
	missionState?: MissionState | undefined;
	executionState?: ExecutionState | undefined;
	hasFailure: boolean;
	revision: number;
	queuePosition?: number | undefined;
	budget: WorkBudget;
	nextAction: string;
}>;

export type CommandMeta = Readonly<{
	commandId: string;
	actor: Actor;
	expectedWorkRevision?: number | undefined;
	roleToken?: string | undefined;
	roleNonce?: string | undefined;
	commandFingerprint?: string | undefined;
	boundWorkId?: string | undefined;
	boundExecutionId?: string | undefined;
	schemaVersion: 1;
}>;

export type RecordView = Readonly<{
	sequence: number;
	recordNumber: number;
	missionRecordNumber?: number | undefined;
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

export type RecordSummaryView = Readonly<
	Pick<
		RecordView,
		| "sequence"
		| "recordNumber"
		| "missionRecordNumber"
		| "id"
		| "kind"
		| "actor"
		| "workId"
		| "missionId"
		| "executionId"
		| "summary"
		| "recordedAt"
	>
>;

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
		| "request-input"
		| "amend-terms"
		| "amend-mission"
		| "launch-observer"
		| "record-assessment"
		| "start-execution"
		| "record-signal"
		| "commit-sandbox"
		| "run-validation"
		| "create-review-request"
		| "run-oracle"
		| "verdict"
		| "deliver-feedback"
		| "record-review"
		| "record-outcome"
		| "cancel"
		| "recover"
		| "rename-work"
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
	title?: string | undefined;
	objective?: string | undefined;
	context?: string | undefined;
	scope?: string | undefined;
	acceptanceCriteria?: readonly string[] | undefined;
	constraints?: readonly string[] | undefined;
	validation?: readonly string[] | undefined;
	allowedPaths?: readonly string[] | undefined;
	missing?: readonly string[] | undefined;
	observationId?: string | undefined;
	subject?: string | undefined;
	maxTokens?: number | undefined;
}>;

export type ActionCommand = Readonly<{
	action: Action["kind"];
	workId: string;
	input?: ActionInput | undefined;
	meta: CommandMeta;
	onRecoveryUpdate?: ((update: RecoveryUpdate) => void) | undefined;
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
	source?: "provider-monitor" | undefined;
	learning?:
		| Readonly<{
				failure: string;
				missionSpecificity: string;
				nextMissionGuidance: string;
		  }>
		| undefined;
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
