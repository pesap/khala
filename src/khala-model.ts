// biome-ignore-all lint/style/noExcessiveLinesPerFile: The Khala schema is deliberately one authoritative file; each record's shape and its guard stay together.
// Khala data model.
//
// This file is the dependency leaf for durable Khala records. It contains no
// I/O and keeps every record shape beside its runtime guard.

// --- Archive envelope -------------------------------------------------------

const EXECUTION_SCHEMA_VERSION = 3;
type ArchiveSchemaVersion = 1 | 2 | typeof EXECUTION_SCHEMA_VERSION;
type ArchiveRecordType =
	| "submission"
	| "conclave-wake"
	| "conclave-recovery"
	| "execution"
	| "signal"
	| "counsel"
	| "verdict"
	| "verdict-delivery"
	| "learning"
	| "mandate"
	| "mission"
	| "pull-request"
	| "work-outcome"
	| "coordination"
	| "intervention"
	| "user-priority"
	| "user-priority-enforcement"
	| "user-model-recovery"
	| "user-worker-action"
	| "attention-dismissal";

type KhalaArchiveRecord = Readonly<{
	recordId: string;
	schemaVersion?: ArchiveSchemaVersion;
	type: ArchiveRecordType;
	projectPath: string;
	workId: string;
	executionId?: string;
	recordedAt: string;
	payload: unknown;
}>;

type KhalaArchiveAppend = Readonly<{
	schemaVersion?: ArchiveSchemaVersion;
	type: ArchiveRecordType;
	workId: string;
	executionId?: string;
	payload: unknown;
}>;

// --- Work and submissions (payload: "submission") ---------------------------

type WorkCostBudget = Readonly<{
	conclaveMaxCostUsdPerTurn?: number;
	executorMaxCostUsdPerTurn?: number;
}>;

type KhalaWork = Readonly<{
	title: string;
	objective: string;
	context: string;
	scope: string;
	acceptanceCriteria: readonly string[];
	constraints: readonly string[];
	plan: readonly string[];
	validation: readonly string[];
	costBudget?: WorkCostBudget;
}>;

type WorkSubmissionRequest = Readonly<{
	workId: string;
	projectPath: string;
	work: KhalaWork;
}>;

const WorkSubmissionStatus = {
	queued: "queued",
	reviewing: "reviewing",
	admitted: "admitted",
	rejected: "rejected",
	// Legacy v1 states remain readable but are never written by v2 code.
	launching: "launching",
	launched: "launched",
} as const;
type WorkSubmissionStatusValue = (typeof WorkSubmissionStatus)[keyof typeof WorkSubmissionStatus];

const KhalaWorkEntryStatus = {
	draft: "draft",
	queued: "queued",
	launched: "launched",
} as const;

// `held` is a transient tool response only; it is not persisted lifecycle state.
const KhalaWorkLaunchStatus = {
	queued: "queued",
	materialized: "materialized",
	held: "held",
	starting: "starting",
	launched: "launched",
} as const;

type KhalaWorkSubmission = Readonly<{
	workId: string;
	projectPath: string;
	status: WorkSubmissionStatusValue;
	work: KhalaWork;
	archivePath: string;
	target?: string;
	sandboxPath?: string;
	mandateId?: string;
	reviewAttemptId?: string;
	rejectionReason?: string;
}>;

const ConclaveWakeStatus = {
	woken: "woken",
	failed: "failed",
} as const;
type ConclaveWakeStatusValue = (typeof ConclaveWakeStatus)[keyof typeof ConclaveWakeStatus];
type ConclaveWakeRecovery = "setup" | "recreate";
type ConclaveWakeFailure = Readonly<{ message: string; recovery: ConclaveWakeRecovery }>;
type ConclaveWakeRecord = Readonly<{
	wakeId: string;
	workId: string;
	status: ConclaveWakeStatusValue;
	attemptedAt: string;
	failure?: string;
	recovery?: ConclaveWakeRecovery;
}>;

const CONCLAVE_RECOVERY_CLAIM_LEASE_MS = 60_000;
const CONCLAVE_RECOVERY_RECORD_CLOCK_SKEW_MS = 5000;
const ConclaveRecoveryStatus = {
	claimed: "claimed",
	renewed: "renewed",
	exhausted: "exhausted",
} as const;
type ConclaveRecoveryClaimRecord = Readonly<{
	recoveryId: string;
	workId: string;
	submissionRecordId: string;
	status: typeof ConclaveRecoveryStatus.claimed;
	attempt: number;
	maxAttempts: number;
	ownerId: string;
	claimedAt: string;
	leaseExpiresAt: string;
}>;
type ConclaveRecoveryRenewalRecord = Readonly<{
	recoveryId: string;
	workId: string;
	submissionRecordId: string;
	status: typeof ConclaveRecoveryStatus.renewed;
	attempt: number;
	maxAttempts: number;
	ownerId: string;
	renewedAt: string;
	leaseExpiresAt: string;
}>;
type ConclaveRecoveryExhaustedRecord = Readonly<{
	recoveryId: string;
	workId: string;
	submissionRecordId: string;
	status: typeof ConclaveRecoveryStatus.exhausted;
	attempt: number;
	maxAttempts: number;
	exhaustedAt: string;
	reason: string;
}>;
type ConclaveRecoveryRecord =
	| ConclaveRecoveryClaimRecord
	| ConclaveRecoveryRenewalRecord
	| ConclaveRecoveryExhaustedRecord;

// --- Mandates and Missions --------------------------------------------------

type MandateRecord = Readonly<{
	mandateId: string;
	workId: string;
	revision: number;
	sourceSubmissionRecordId: string;
	terms: KhalaWork;
	admittedByParticipantId: string;
	admittedAt: string;
}>;

type MissionAssignment = KhalaWork;

type MissionRecord = Readonly<{
	missionId: string;
	workId: string;
	mandateId: string;
	predecessorMissionId?: string;
	causedByVerdictId?: string;
	causedByCoordinationId?: string;
	assignment: MissionAssignment;
	assignedParticipantId: string;
	createdAt: string;
}>;

type ExecutorPromptIdentity = Readonly<{
	packageVersion: string;
	promptSha256: string;
}>;

type UpstreamExecutionBase = Readonly<{
	kind: "upstream-execution";
	workId: string;
	missionId: string;
	executionId: string;
	remote: string;
	branch: string;
	headCommit: string;
}>;

type ExecutionPurpose =
	| Readonly<{ kind: "mission"; missionId: string }>
	| Readonly<{ kind: "observation"; submissionRecordId: string }>;

// --- Executions (payload: "execution") --------------------------------------

const ExecutorStatus = {
	starting: "starting",
	running: "running",
	finished: "finished",
	failed: "failed",
} as const;
type ExecutorStatusValue = (typeof ExecutorStatus)[keyof typeof ExecutorStatus];

type ExecutorKind = "executor" | "observer";
type ExecutorFailureCategory = "model-unavailable";

type ExecutorRecord = Readonly<{
	executionId: string;
	workId: string;
	executorName: string;
	kind?: ExecutorKind;
	participantId?: string;
	purpose?: ExecutionPurpose;
	missionId?: string;
	projectPath: string;
	sandboxPath: string;
	target?: string;
	launcher: string;
	piSessionId?: string;
	sessionPath?: string;
	promptIdentity?: ExecutorPromptIdentity;
	upstreamBase?: UpstreamExecutionBase;
	model?: string;
	recoveryOfExecutionId?: string;
	recoveryRequestId?: string;
	failureCategory?: ExecutorFailureCategory;
	failureMessage?: string;
	status: ExecutorStatusValue;
	startedAt: string;
	lastSignalAt?: string;
}>;

type UserModelRecoveryRecord = Readonly<{
	requestId: string;
	role: "executor";
	model: string;
	status: "selected" | "applied";
	workId: string;
	missionId: string;
	predecessorExecutionId: string;
	replacementExecutionId?: string;
	requestedAt: string;
	appliedAt?: string;
}>;

type UserWorkerActionKind = "try-current-execution" | "continue-current-mission" | "stop-current-execution";
type UserWorkerActionRequest = Readonly<{
	phase: "request";
	actionId: string;
	kind: UserWorkerActionKind;
	conditionId: string;
	workId: string;
	expectedMissionId: string;
	expectedExecutionId?: string;
	model?: string;
	requestedAt: string;
}>;
type UserWorkerActionOutcome = Readonly<{
	phase: "outcome";
	actionId: string;
	kind: UserWorkerActionKind;
	conditionId: string;
	workId: string;
	requestRecordId: string;
	status: "applied" | "rejected" | "failed";
	missionId?: string;
	executionId?: string;
	predecessorExecutionId?: string;
	reason?: string;
	recordedAt: string;
}>;
type UserWorkerActionRecord = UserWorkerActionRequest | UserWorkerActionOutcome;

type AttentionDismissalRecord = Readonly<{
	dismissalId: string;
	conditionId: string;
	workId?: string;
	kind: string;
	dismissedAt: string;
}>;

// --- Signals (payload: "signal") --------------------------------------------

type SignalKind = "progress" | "blocked" | "finished";

type SignalRecord = Readonly<{
	signalId: string;
	workId: string;
	executionId: string;
	executorName: string;
	missionId?: string;
	participantId?: string;
	kind: SignalKind;
	summary: string;
	evidence: readonly string[];
	observedAt: string;
}>;

// --- Verdicts (payload: "verdict") ------------------------------------------

type VerdictDecision = "continue" | "retry" | "finish" | "reject";

type RetryHandoff = Readonly<{
	failedCriteria: readonly string[];
	completedWork: readonly string[];
	requiredChanges: readonly string[];
	nonGoals: readonly string[];
	validation: readonly string[];
}>;

type VerdictRecord = Readonly<{
	workId: string;
	executionId: string;
	signalId: string;
	missionId?: string;
	governingMandateId?: string;
	issuedByParticipantId?: string;
	decision: VerdictDecision;
	reason: string;
	verdictId: string;
	issuedAt: string;
	sourcePullRequestId?: string;
	retryHandoff?: RetryHandoff;
	successorAssignment?: MissionAssignment;
}>;

// --- Verdict delivery -------------------------------------------------------

const VerdictDeliveryStatus = {
	pending: "pending",
	delivered: "delivered",
	failed: "failed",
} as const;
type VerdictDeliveryStatusValue = (typeof VerdictDeliveryStatus)[keyof typeof VerdictDeliveryStatus];

type VerdictDeliveryRecord = Readonly<{
	deliveryId: string;
	verdictId: string;
	workId: string;
	executionId: string;
	decision: VerdictDecision;
	message: string;
	status: VerdictDeliveryStatusValue;
	target?: string;
	launcher?: string;
	error?: string;
	createdAt: string;
	deliveredAt?: string;
}>;

// --- Pull requests and Work Outcomes ---------------------------------------

const PullRequestStatus = {
	reviewable: "reviewable",
	draft: "draft",
	open: "open",
	changesRequested: "changes-requested",
	merged: "merged",
	closed: "closed",
} as const;
type PullRequestStatusValue = (typeof PullRequestStatus)[keyof typeof PullRequestStatus];

type PullRequestRecord = Readonly<{
	pullRequestId: string;
	workId: string;
	missionId: string;
	executionId: string;
	status: PullRequestStatusValue;
	url?: string;
	number?: number;
	sourceBranch?: string;
	targetBranch?: string;
	planningCommit?: string;
	headCommit?: string;
	mergeCommit?: string;
	changedFiles: readonly string[];
	diffSummary: string;
	validationResults: readonly string[];
	reviewFeedback: readonly string[];
	unresolvedGaps: readonly string[];
	reviewer?: string;
	relatedPullRequestUrl?: string;
	remoteConfirmedAt?: string;
	recordedAt: string;
}>;

type WorkOutcomeRecord = Readonly<{
	outcomeId: string;
	workId: string;
	mandateId: string;
	missionId: string;
	executionId: string;
	pullRequestId: string;
	pullRequestUrl?: string;
	pullRequestNumber?: number;
	sourceBranch?: string;
	targetBranch?: string;
	finalHeadCommit: string;
	mergeCommit: string;
	changedFiles: readonly string[];
	diffSummary: string;
	validationResults: readonly string[];
	reviewFeedback: readonly string[];
	unresolvedGaps: readonly string[];
	acceptingActor: string;
	acceptedAt: string;
}>;

// --- Counsel (payload: "counsel") -------------------------------------------

type CounselRecord = Readonly<{
	workId: string;
	executionId?: string;
	sourceRecordIds: readonly string[];
	observations: readonly string[];
	recommendations: readonly string[];
	uncertainties: readonly string[];
	counselId: string;
	authorSession?: string;
	createdAt: string;
}>;

// --- Learning (payload: "learning") -----------------------------------------

type LearningRecord = Readonly<{
	learningId: string;
	workId: string;
	executionId: string;
	observerName: string;
	topic: string;
	summary: string;
	evidence: readonly string[];
	sourcePaths: readonly string[];
	createdAt: string;
}>;

// --- Supervision Archive records -------------------------------------------

type CoordinationPhase = "decision" | "override" | "release" | "invalidation" | "resolution";
type CoordinationRelation = "dependency" | "peer-conflict";
type CoordinationResolution = "released" | "terminal-failure";
const CoordinationExecutionIdentityPolicy = {
	activeExecution: "active-execution",
} as const;
type CoordinationExecutionIdentityPolicyValue =
	(typeof CoordinationExecutionIdentityPolicy)[keyof typeof CoordinationExecutionIdentityPolicy];
type CoordinationClassification = Readonly<{
	observedFiles: readonly string[];
	observedModules: readonly string[];
	observedApis: readonly string[];
	observedContracts: readonly string[];
}>;
type CoordinationRemoteObservation = Readonly<{
	remote: string;
	branch: string;
	headCommit: string | null;
	observedAt: string;
}>;
type CoordinationDependent = Readonly<{
	workId: string;
	missionId: string;
	executionId?: string;
	supersededHead: string;
}>;
type CoordinationRecord = Readonly<{
	coordinationId: string;
	actionId: string;
	phase: CoordinationPhase;
	relation: CoordinationRelation;
	workId: string;
	missionId: string;
	executionId?: string;
	selectedWorkId: string;
	selectedMissionId: string;
	relatedWorkId: string;
	relatedMissionId: string;
	relatedExecutionId?: string;
	selectedExecutionId?: string;
	upstreamWorkId?: string;
	upstreamMissionId?: string;
	upstreamExecutionId?: string;
	remote?: string;
	branch?: string;
	upstreamHead?: string;
	replacementHead?: string | null;
	affectedDependents?: readonly CoordinationDependent[];
	remoteObservation?: CoordinationRemoteObservation;
	causedByCoordinationId?: string;
	userEntryId?: string;
	releasedExecutionId?: string;
	resolution?: CoordinationResolution;
	resolutionEvidenceRecordId?: string;
	classification?: CoordinationClassification;
	// New peer-conflict decisions self-describe the active-Execution identity rule;
	// legacy schema-v2 decisions omit this field and remain historical evidence.
	peerConflictExecutionIdentityPolicy?: CoordinationExecutionIdentityPolicyValue;
	reason: string;
	priorityId?: string;
}>;

// --- User Priority ---------------------------------------------------------

const UserPriorityStatus = {
	pending: "pending",
	ignored: "ignored",
} as const;
type UserPriorityStatusValue = (typeof UserPriorityStatus)[keyof typeof UserPriorityStatus];

const MAX_PRIORITY_REASON_LENGTH = 500;
const USER_PRIORITY_ID_PATTERN = /^priority-[a-f0-9]{64}$/;
const USER_PRIORITY_ACTION_PATTERN = /^action-[a-f0-9]{64}$/;

type UserPriorityProvenance = Readonly<{
	sessionId: string;
	entryId: string;
	contentSha256: string;
}>;

// One append-only User priority request. The pending phase is written by the
// User tool from the exact persisted User turn; the ignored phase is the stale
// terminal disposition written by the Conclave. Applied is derived from a
// Coordination override that references priorityId, never stored on this record.
type UserPriorityRecord = Readonly<{
	priorityId: string;
	workId: string;
	selectedWorkId: string;
	relatedWorkId: string;
	coordinationId: string;
	// The single deterministic Coordination action that may apply this priority.
	actionId: string;
	// The single deterministic stop action that may enforce this priority.
	stopActionId: string;
	reason: string;
	provenance: UserPriorityProvenance;
	status: UserPriorityStatusValue;
	createdAt: string;
	ignoredAt?: string;
	ignoredReason?: string;
}>;

const UserPriorityEnforcementPhase = {
	prepared: "prepared",
	baseline: "baseline",
	handoff: "handoff",
	enforced: "enforced",
	terminal: "terminal",
} as const;
type UserPriorityEnforcementPhaseValue =
	(typeof UserPriorityEnforcementPhase)[keyof typeof UserPriorityEnforcementPhase];

// Enforcement is a separate append-only phase stream so a Coordination override
// cannot make a priority disappear while its lower-priority Execution still needs
// the deterministic stop protocol. The phase identity is immutable; only the
// bounded enforcement evidence advances.
type UserPriorityEnforcementRecord = Readonly<{
	priorityId: string;
	coordinationId: string;
	workId: string;
	selectedWorkId: string;
	relatedWorkId: string;
	losingWorkId: string;
	losingMissionId: string;
	losingExecutionId?: string;
	actionId: string;
	marker: string;
	phase: UserPriorityEnforcementPhaseValue;
	baselineSignalIds: readonly string[];
	stopEntryIds?: readonly string[];
	interventionId?: string;
	blockedSignalId?: string;
	terminalExecutionRecordId?: string;
}>;

type InterventionFailureCategory =
	| "scope"
	| "constraint"
	| "acceptance"
	| "plan"
	| "validation"
	| "no-progress"
	| "unsafe-assumption"
	| "budget"
	| "dependency"
	| "other";
type InterventionMode = "correction" | "stop";
type InterventionOutcomeKind = "resolved" | "partially-resolved" | "ignored" | "escalated";
type InterventionIdentity = Readonly<{
	interventionId: string;
	workId: string;
	mandateId: string;
	missionId: string;
	executionId: string;
	conclaveParticipantId: string;
	executorParticipantId: string;
	piSessionId: string;
	assessmentId: string;
	failureSummary: string;
	category: InterventionFailureCategory;
	missionTerm: string;
	message: string;
	messageSha256?: string;
	promptIdentity: ExecutorPromptIdentity;
}>;
type InterventionIssuanceRecord = Readonly<
	InterventionIdentity & {
		phase: "issuance";
		actionId: string;
		mode: InterventionMode;
		piEntryIds: readonly string[];
		sentAt: string;
		transportResult: "confirmed";
	}
>;
type InterventionOutcomeRecord = Readonly<
	InterventionIdentity & {
		phase: "outcome";
		actionId: string;
		outcome: InterventionOutcomeKind;
		observedEntryIds: readonly string[];
		reason: string;
		resultingSignalId?: string;
		resultingVerdictId?: string;
		resultingCoordinationId?: string;
		resultingExecutionId?: string;
		failedExecutionRecordId?: string;
	}
>;
type InterventionRecord = InterventionIssuanceRecord | InterventionOutcomeRecord;
const GENERIC_INTERVENTION_SUMMARY_PATTERN = /^(unknown|n\/a|none|not applicable|no reason|unspecified)$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

// --- Guards -----------------------------------------------------------------

type GuardRecord = Record<string, unknown> &
	Readonly<{
		title?: unknown;
		objective?: unknown;
		context?: unknown;
		scope?: unknown;
		acceptanceCriteria?: unknown;
		constraints?: unknown;
		plan?: unknown;
		validation?: unknown;
		costBudget?: unknown;
		conclaveMaxCostUsdPerTurn?: unknown;
		executorMaxCostUsdPerTurn?: unknown;
		packageVersion?: unknown;
		promptSha256?: unknown;
		workId?: unknown;
		wakeId?: unknown;
		attemptedAt?: unknown;
		failure?: unknown;
		recovery?: unknown;
		recoveryId?: unknown;
		submissionRecordId?: unknown;
		attempt?: unknown;
		maxAttempts?: unknown;
		ownerId?: unknown;
		claimedAt?: unknown;
		renewedAt?: unknown;
		leaseExpiresAt?: unknown;
		exhaustedAt?: unknown;
		projectPath?: unknown;
		status?: unknown;
		work?: unknown;
		archivePath?: unknown;
		target?: unknown;
		sandboxPath?: unknown;
		mandateId?: unknown;
		reviewAttemptId?: unknown;
		rejectionReason?: unknown;
		executionId?: unknown;
		executorName?: unknown;
		kind?: unknown;
		launcher?: unknown;
		piSessionId?: unknown;
		sessionPath?: unknown;
		promptIdentity?: unknown;
		upstreamBase?: unknown;
		startedAt?: unknown;
		participantId?: unknown;
		purpose?: unknown;
		missionId?: unknown;
		signalId?: unknown;
		summary?: unknown;
		evidence?: unknown;
		observedAt?: unknown;
		governingMandateId?: unknown;
		issuedByParticipantId?: unknown;
		decision?: unknown;
		reason?: unknown;
		verdictId?: unknown;
		issuedAt?: unknown;
		sourcePullRequestId?: unknown;
		retryHandoff?: unknown;
		successorAssignment?: unknown;
		deliveryId?: unknown;
		message?: unknown;
		deliveredAt?: unknown;
		error?: unknown;
		pullRequestId?: unknown;
		url?: unknown;
		number?: unknown;
		sourceBranch?: unknown;
		targetBranch?: unknown;
		planningCommit?: unknown;
		headCommit?: unknown;
		mergeCommit?: unknown;
		changedFiles?: unknown;
		diffSummary?: unknown;
		validationResults?: unknown;
		reviewFeedback?: unknown;
		unresolvedGaps?: unknown;
		reviewer?: unknown;
		relatedPullRequestUrl?: unknown;
		remoteConfirmedAt?: unknown;
		outcomeId?: unknown;
		pullRequestUrl?: unknown;
		pullRequestNumber?: unknown;
		finalHeadCommit?: unknown;
		acceptingActor?: unknown;
		acceptedAt?: unknown;
		learningId?: unknown;
		observerName?: unknown;
		topic?: unknown;
		sourcePaths?: unknown;
		createdAt?: unknown;
		recordedAt?: unknown;
		sourceSubmissionRecordId?: unknown;
		terms?: unknown;
		revision?: unknown;
		admittedByParticipantId?: unknown;
		admittedAt?: unknown;
		predecessorMissionId?: unknown;
		causedByVerdictId?: unknown;
		causedByCoordinationId?: unknown;
		assignment?: unknown;
		assignedParticipantId?: unknown;
		sourceRecordIds?: unknown;
		observations?: unknown;
		recommendations?: unknown;
		uncertainties?: unknown;
		counselId?: unknown;
		authorSession?: unknown;
		coordinationId?: unknown;
		actionId?: unknown;
		phase?: unknown;
		relation?: unknown;
		selectedWorkId?: unknown;
		selectedMissionId?: unknown;
		relatedWorkId?: unknown;
		relatedMissionId?: unknown;
		relatedExecutionId?: unknown;
		selectedExecutionId?: unknown;
		upstreamWorkId?: unknown;
		upstreamMissionId?: unknown;
		upstreamExecutionId?: unknown;
		remote?: unknown;
		branch?: unknown;
		upstreamHead?: unknown;
		supersededHead?: unknown;
		replacementHead?: unknown;
		affectedDependents?: unknown;
		remoteObservation?: unknown;
		userEntryId?: unknown;
		releasedExecutionId?: unknown;
		resolution?: unknown;
		resolutionEvidenceRecordId?: unknown;
		classification?: unknown;
		observedFiles?: unknown;
		observedModules?: unknown;
		observedApis?: unknown;
		observedContracts?: unknown;
		conclaveParticipantId?: unknown;
		executorParticipantId?: unknown;
		assessmentId?: unknown;
		failureSummary?: unknown;
		category?: unknown;
		missionTerm?: unknown;
		messageSha256?: unknown;
		mode?: unknown;
		piEntryIds?: unknown;
		sentAt?: unknown;
		transportResult?: unknown;
		outcome?: unknown;
		observedEntryIds?: unknown;
		resultingSignalId?: unknown;
		resultingVerdictId?: unknown;
		resultingCoordinationId?: unknown;
		resultingExecutionId?: unknown;
		failedExecutionRecordId?: unknown;
		interventionId?: unknown;
		priorityId?: unknown;
		provenance?: unknown;
		sessionId?: unknown;
		entryId?: unknown;
		contentSha256?: unknown;
		ignoredAt?: unknown;
		ignoredReason?: unknown;
		stopActionId?: unknown;
		losingWorkId?: unknown;
		losingMissionId?: unknown;
		losingExecutionId?: unknown;
		marker?: unknown;
		baselineSignalIds?: unknown;
		stopEntryIds?: unknown;
		blockedSignalId?: unknown;
		terminalExecutionRecordId?: unknown;
		model?: unknown;
		recoveryOfExecutionId?: unknown;
		recoveryRequestId?: unknown;
		failureCategory?: unknown;
		failureMessage?: unknown;
		requestId?: unknown;
		role?: unknown;
		predecessorExecutionId?: unknown;
		requestedAt?: unknown;
		replacementExecutionId?: unknown;
		appliedAt?: unknown;
		conditionId?: unknown;
		expectedMissionId?: unknown;
		expectedExecutionId?: unknown;
		requestRecordId?: unknown;
		dismissalId?: unknown;
		dismissedAt?: unknown;
	}>;

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
	return isStringArray(value) && value.length > 0 && value.every((item) => item.trim().length > 0);
}

function isArchiveRecordType(value: unknown): value is ArchiveRecordType {
	return (
		value === "submission" ||
		value === "conclave-wake" ||
		value === "conclave-recovery" ||
		value === "execution" ||
		value === "signal" ||
		value === "counsel" ||
		value === "verdict" ||
		value === "verdict-delivery" ||
		value === "learning" ||
		value === "mandate" ||
		value === "mission" ||
		value === "pull-request" ||
		value === "work-outcome" ||
		value === "user-priority" ||
		value === "user-priority-enforcement" ||
		value === "user-model-recovery" ||
		value === "coordination" ||
		value === "intervention" ||
		value === "user-worker-action" ||
		value === "attention-dismissal"
	);
}

function isArchiveSchemaVersion(value: unknown): value is ArchiveSchemaVersion {
	return value === 1 || value === 2 || value === EXECUTION_SCHEMA_VERSION;
}

function isArchiveRecord(value: unknown): value is KhalaArchiveRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as {
		recordId?: unknown;
		schemaVersion?: unknown;
		type?: unknown;
		projectPath?: unknown;
		workId?: unknown;
		executionId?: unknown;
		recordedAt?: unknown;
		payload?: unknown;
	};
	if (
		typeof record.recordId !== "string" ||
		(record.schemaVersion !== undefined && !isArchiveSchemaVersion(record.schemaVersion)) ||
		!isArchiveRecordType(record.type) ||
		typeof record.projectPath !== "string" ||
		typeof record.workId !== "string" ||
		(record.executionId !== undefined && typeof record.executionId !== "string") ||
		typeof record.recordedAt !== "string" ||
		!("payload" in value)
	) {
		return false;
	}
	if (record.schemaVersion === EXECUTION_SCHEMA_VERSION) {
		return record.type === "execution" && isV3ExecutorRecord(record.payload);
	}
	if (record.schemaVersion === 2 || isImplicitV2ArchiveRecordType(record.type)) {
		return isArchivePayloadV2(record.type, record.payload);
	}
	return isArchivePayloadLegacy(record.type, record.payload);
}

function isImplicitV2ArchiveRecordType(type: ArchiveRecordType): boolean {
	return (
		type === "verdict-delivery" ||
		type === "conclave-wake" ||
		type === "conclave-recovery" ||
		type === "mandate" ||
		type === "mission" ||
		type === "pull-request" ||
		type === "work-outcome" ||
		type === "user-priority" ||
		type === "user-priority-enforcement" ||
		type === "user-model-recovery" ||
		type === "user-worker-action" ||
		type === "attention-dismissal"
	);
}

function isArchivePayloadLegacy(type: ArchiveRecordType, payload: unknown): boolean {
	if (type === "submission") {
		return isWorkSubmission(payload);
	}
	if (type === "execution") {
		return isExecutorRecord(payload);
	}
	if (type === "signal") {
		return isSignal(payload);
	}
	if (type === "counsel") {
		return isCounselRecord(payload);
	}
	if (type === "verdict") {
		return isVerdict(payload);
	}
	if (type === "learning") {
		return isLearningRecord(payload);
	}
	return false;
}

type ArchivePayloadGuard = (payload: unknown) => boolean;
const archivePayloadV2Guards: Partial<Record<ArchiveRecordType, ArchivePayloadGuard>> = {
	"conclave-wake": isConclaveWakeRecord,
	"conclave-recovery": isConclaveRecoveryRecord,
	coordination: isCoordinationRecord,
	intervention: isInterventionRecord,
	submission: isV2WorkSubmission,
	execution: isV2ExecutorRecord,
	signal: isV2Signal,
	counsel: isCounselRecord,
	verdict: isV2Verdict,
	learning: isLearningRecord,
	"verdict-delivery": isVerdictDelivery,
	mandate: isMandateRecord,
	mission: isMissionRecord,
	"pull-request": isPullRequestRecord,
	"user-priority": isUserPriorityRecord,
	"user-priority-enforcement": isUserPriorityEnforcementRecord,
	"user-model-recovery": isUserModelRecoveryRecord,
	"user-worker-action": isUserWorkerActionRecord,
	"attention-dismissal": isAttentionDismissalRecord,
};

function isArchivePayloadV2(type: ArchiveRecordType, payload: unknown): boolean {
	const guard = archivePayloadV2Guards[type];
	if (guard !== undefined) {
		return guard(payload);
	}
	return isWorkOutcomeRecord(payload);
}

function isKhalaWork(value: unknown): value is KhalaWork {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.title === "string" &&
		typeof record.objective === "string" &&
		typeof record.context === "string" &&
		typeof record.scope === "string" &&
		isStringArray(record.acceptanceCriteria) &&
		isStringArray(record.constraints) &&
		isStringArray(record.plan) &&
		isStringArray(record.validation) &&
		(record.costBudget === undefined || isWorkCostBudget(record.costBudget))
	);
}

function isWorkCostBudget(value: unknown): value is WorkCostBudget {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const hasConclave = record.conclaveMaxCostUsdPerTurn !== undefined;
	const hasExecutor = record.executorMaxCostUsdPerTurn !== undefined;
	return (
		(hasConclave || hasExecutor) &&
		(!hasConclave || isPositiveFiniteNumber(record.conclaveMaxCostUsdPerTurn)) &&
		(!hasExecutor || isPositiveFiniteNumber(record.executorMaxCostUsdPerTurn))
	);
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPromptIdentity(value: unknown): value is ExecutorPromptIdentity {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		isNonEmptyString(record.packageVersion) &&
		typeof record.promptSha256 === "string" &&
		SHA256_PATTERN.test(record.promptSha256)
	);
}

function isUpstreamExecutionBase(value: unknown): value is UpstreamExecutionBase {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		record.kind === "upstream-execution" &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.missionId) &&
		isNonEmptyString(record.executionId) &&
		isNonEmptyString(record.remote) &&
		isNonEmptyString(record.branch) &&
		isNonEmptyString(record.headCommit)
	);
}

function isWorkSubmission(value: unknown): value is KhalaWorkSubmission {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.workId === "string" &&
		typeof record.projectPath === "string" &&
		(record.status === WorkSubmissionStatus.queued ||
			record.status === WorkSubmissionStatus.reviewing ||
			record.status === WorkSubmissionStatus.admitted ||
			record.status === WorkSubmissionStatus.rejected ||
			record.status === WorkSubmissionStatus.launching ||
			record.status === WorkSubmissionStatus.launched) &&
		isKhalaWork(record.work) &&
		typeof record.archivePath === "string"
	);
}

function isV2WorkSubmission(value: unknown): value is KhalaWorkSubmission {
	if (!isWorkSubmission(value) || typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (
		record.status === WorkSubmissionStatus.launching ||
		record.status === WorkSubmissionStatus.launched ||
		(record.reviewAttemptId !== undefined && typeof record.reviewAttemptId !== "string") ||
		(record.mandateId !== undefined && typeof record.mandateId !== "string") ||
		(record.rejectionReason !== undefined && typeof record.rejectionReason !== "string")
	) {
		return false;
	}
	if (record.status === WorkSubmissionStatus.admitted) {
		return typeof record.mandateId === "string";
	}
	if (record.status === WorkSubmissionStatus.rejected) {
		return typeof record.rejectionReason === "string";
	}
	return true;
}

function isConclaveWakeRecord(value: unknown): value is ConclaveWakeRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (
		!(isNonEmptyString(record.wakeId) && isNonEmptyString(record.workId) && isNonEmptyString(record.attemptedAt)) ||
		(record.status !== ConclaveWakeStatus.woken && record.status !== ConclaveWakeStatus.failed)
	) {
		return false;
	}
	if (record.status === ConclaveWakeStatus.woken) {
		return record.failure === undefined && record.recovery === undefined;
	}
	return isNonEmptyString(record.failure) && (record.recovery === "setup" || record.recovery === "recreate");
}

function isRecoveryLeaseBoundedFromRecord(recordedAt: string, leaseExpiresAt: string): boolean {
	const recorded = Date.parse(recordedAt);
	const expires = Date.parse(leaseExpiresAt);
	return (
		Number.isFinite(recorded) &&
		Number.isFinite(expires) &&
		expires > recorded &&
		expires - recorded <= CONCLAVE_RECOVERY_CLAIM_LEASE_MS
	);
}

function isRecoveryTimestampNearRecord(recordedAt: string, payloadTimestamp: string): boolean {
	const recorded = Date.parse(recordedAt);
	const payload = Date.parse(payloadTimestamp);
	return (
		Number.isFinite(recorded) &&
		Number.isFinite(payload) &&
		Math.abs(recorded - payload) <= CONCLAVE_RECOVERY_RECORD_CLOCK_SKEW_MS
	);
}

function isValidRecoveryLease(startedAt: unknown, leaseExpiresAt: unknown): boolean {
	if (!(isNonEmptyString(startedAt) && isNonEmptyString(leaseExpiresAt))) {
		return false;
	}
	const started = Date.parse(startedAt);
	const expires = Date.parse(leaseExpiresAt);
	return (
		Number.isFinite(started) &&
		Number.isFinite(expires) &&
		expires > started &&
		expires - started <= CONCLAVE_RECOVERY_CLAIM_LEASE_MS
	);
}

function isConclaveRecoveryRecord(value: unknown): value is ConclaveRecoveryRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const common =
		isNonEmptyString(record.recoveryId) &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.submissionRecordId) &&
		typeof record.attempt === "number" &&
		Number.isInteger(record.attempt) &&
		record.attempt > 0 &&
		typeof record.maxAttempts === "number" &&
		Number.isInteger(record.maxAttempts) &&
		record.maxAttempts > 0 &&
		record.attempt <= record.maxAttempts;
	if (!common) {
		return false;
	}
	if (record.status === ConclaveRecoveryStatus.claimed) {
		return (
			isNonEmptyString(record.ownerId) &&
			isNonEmptyString(record.claimedAt) &&
			record.renewedAt === undefined &&
			isValidRecoveryLease(record.claimedAt, record.leaseExpiresAt) &&
			record.exhaustedAt === undefined
		);
	}
	if (record.status === ConclaveRecoveryStatus.renewed) {
		return (
			isNonEmptyString(record.ownerId) &&
			record.claimedAt === undefined &&
			isNonEmptyString(record.renewedAt) &&
			isValidRecoveryLease(record.renewedAt, record.leaseExpiresAt) &&
			record.exhaustedAt === undefined
		);
	}
	return (
		record.status === ConclaveRecoveryStatus.exhausted &&
		record.attempt === record.maxAttempts &&
		record.ownerId === undefined &&
		record.claimedAt === undefined &&
		record.renewedAt === undefined &&
		record.leaseExpiresAt === undefined &&
		isNonEmptyString(record.exhaustedAt) &&
		isNonEmptyString(record.reason)
	);
}

function isExecutorRecord(value: unknown): value is ExecutorRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.executionId === "string" &&
		typeof record.workId === "string" &&
		typeof record.executorName === "string" &&
		(record.kind === undefined || record.kind === "executor" || record.kind === "observer") &&
		typeof record.projectPath === "string" &&
		typeof record.sandboxPath === "string" &&
		typeof record.launcher === "string" &&
		(record.piSessionId === undefined || isNonEmptyString(record.piSessionId)) &&
		(record.sessionPath === undefined || isNonEmptyString(record.sessionPath)) &&
		(record.promptIdentity === undefined || isPromptIdentity(record.promptIdentity)) &&
		(record.upstreamBase === undefined || isUpstreamExecutionBase(record.upstreamBase)) &&
		(record.model === undefined || isNonEmptyString(record.model)) &&
		(record.recoveryOfExecutionId === undefined || isNonEmptyString(record.recoveryOfExecutionId)) &&
		(record.recoveryRequestId === undefined || isNonEmptyString(record.recoveryRequestId)) &&
		(record.failureCategory === undefined || record.failureCategory === "model-unavailable") &&
		(record.failureMessage === undefined || isNonEmptyString(record.failureMessage)) &&
		(record.status === ExecutorStatus.starting ||
			record.status === ExecutorStatus.running ||
			record.status === ExecutorStatus.finished ||
			record.status === ExecutorStatus.failed) &&
		typeof record.startedAt === "string"
	);
}

function isMissionExecutorRecord(
	record: ExecutorRecord,
): record is ExecutorRecord & Readonly<{ purpose: Extract<ExecutionPurpose, { kind: "mission" }> }> {
	return record.kind !== "observer" && record.purpose?.kind === "mission";
}

function isExecutionPurpose(value: unknown): value is ExecutionPurpose {
	if (typeof value !== "object" || value === null || !("kind" in value)) {
		return false;
	}
	const record = value as { kind?: unknown; missionId?: unknown; submissionRecordId?: unknown };
	if (record.kind === "mission") {
		return typeof record.missionId === "string" && record.missionId.length > 0;
	}
	return (
		record.kind === "observation" &&
		typeof record.submissionRecordId === "string" &&
		record.submissionRecordId.length > 0
	);
}

// Schema v2 predates recoverable Pi identity bindings. Its durable records must
// retain their original validation contract during replay; new records use v3.
function isV2ExecutorRecord(value: unknown): value is ExecutorRecord {
	if (!isExecutorRecord(value) || typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (typeof record.participantId !== "string" || !isExecutionPurpose(record.purpose)) {
		return false;
	}
	if (record.purpose.kind === "mission") {
		return record.kind !== "observer" && record.missionId === record.purpose.missionId;
	}
	return record.kind === "observer" && record.missionId === undefined;
}

function isV3ExecutorRecord(value: unknown): value is ExecutorRecord {
	if (!isV2ExecutorRecord(value) || typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const { purpose } = record;
	if (!isExecutionPurpose(purpose)) {
		return false;
	}
	if (purpose.kind !== "mission" || record.status !== ExecutorStatus.running) {
		return true;
	}
	return (
		isNonEmptyString(record.piSessionId) &&
		isNonEmptyString(record.sessionPath) &&
		isPromptIdentity(record.promptIdentity)
	);
}

function isSignalKind(value: unknown): value is SignalKind {
	return value === "progress" || value === "blocked" || value === "finished";
}

function isSignal(value: unknown): value is SignalRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.signalId === "string" &&
		typeof record.workId === "string" &&
		typeof record.executionId === "string" &&
		typeof record.executorName === "string" &&
		(record.missionId === undefined || typeof record.missionId === "string") &&
		(record.participantId === undefined || typeof record.participantId === "string") &&
		isSignalKind(record.kind) &&
		typeof record.summary === "string" &&
		isStringArray(record.evidence) &&
		typeof record.observedAt === "string"
	);
}

function isV2Signal(value: unknown): value is SignalRecord {
	return isSignal(value) && typeof value.missionId === "string" && typeof value.participantId === "string";
}

function isVerdictDecision(value: unknown): value is VerdictDecision {
	return value === "continue" || value === "retry" || value === "finish" || value === "reject";
}

function isVerdict(value: unknown): value is VerdictRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.workId === "string" &&
		typeof record.executionId === "string" &&
		typeof record.signalId === "string" &&
		(record.missionId === undefined || typeof record.missionId === "string") &&
		(record.governingMandateId === undefined || typeof record.governingMandateId === "string") &&
		(record.issuedByParticipantId === undefined || typeof record.issuedByParticipantId === "string") &&
		isVerdictDecision(record.decision) &&
		typeof record.reason === "string" &&
		typeof record.verdictId === "string" &&
		typeof record.issuedAt === "string" &&
		(record.sourcePullRequestId === undefined || typeof record.sourcePullRequestId === "string") &&
		(record.retryHandoff === undefined || isRetryHandoff(record.retryHandoff)) &&
		(record.successorAssignment === undefined || isKhalaWork(record.successorAssignment))
	);
}

function isRetryHandoff(value: unknown): value is RetryHandoff {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as {
		failedCriteria?: unknown;
		completedWork?: unknown;
		requiredChanges?: unknown;
		nonGoals?: unknown;
		validation?: unknown;
	};
	return (
		isNonEmptyStringArray(record.failedCriteria) &&
		isNonEmptyStringArray(record.completedWork) &&
		isNonEmptyStringArray(record.requiredChanges) &&
		isNonEmptyStringArray(record.nonGoals) &&
		isNonEmptyStringArray(record.validation)
	);
}

function isUserModelRecoveryRecord(value: unknown): value is UserModelRecoveryRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		isNonEmptyString(record.requestId) &&
		record.role === "executor" &&
		isNonEmptyString(record.model) &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.missionId) &&
		isNonEmptyString(record.predecessorExecutionId) &&
		(record.status === "selected" || record.status === "applied") &&
		(record.replacementExecutionId === undefined || isNonEmptyString(record.replacementExecutionId)) &&
		isNonEmptyString(record.requestedAt) &&
		(record.appliedAt === undefined || isNonEmptyString(record.appliedAt))
	);
}

function isUserWorkerActionKind(value: unknown): value is UserWorkerActionKind {
	return (
		value === "try-current-execution" || value === "continue-current-mission" || value === "stop-current-execution"
	);
}

function isUserWorkerActionRecord(value: unknown): value is UserWorkerActionRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const common =
		isNonEmptyString(record.actionId) &&
		isUserWorkerActionKind(record.kind) &&
		isNonEmptyString(record.conditionId) &&
		isNonEmptyString(record.workId);
	if (!common) {
		return false;
	}
	if (record.phase === "request") {
		return (
			isNonEmptyString(record.expectedMissionId) &&
			(record.expectedExecutionId === undefined || isNonEmptyString(record.expectedExecutionId)) &&
			(record.model === undefined || isNonEmptyString(record.model)) &&
			isNonEmptyString(record.requestedAt) &&
			record.requestRecordId === undefined &&
			record.status === undefined &&
			record.recordedAt === undefined
		);
	}
	return (
		record.phase === "outcome" &&
		isNonEmptyString(record.requestRecordId) &&
		(record.status === "applied" || record.status === "rejected" || record.status === "failed") &&
		(record.missionId === undefined || isNonEmptyString(record.missionId)) &&
		(record.executionId === undefined || isNonEmptyString(record.executionId)) &&
		(record.predecessorExecutionId === undefined || isNonEmptyString(record.predecessorExecutionId)) &&
		(record.reason === undefined || isNonEmptyString(record.reason)) &&
		isNonEmptyString(record.recordedAt) &&
		record.expectedMissionId === undefined &&
		record.expectedExecutionId === undefined &&
		record.model === undefined &&
		record.requestedAt === undefined
	);
}

function isAttentionDismissalRecord(value: unknown): value is AttentionDismissalRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		isNonEmptyString(record.dismissalId) &&
		isNonEmptyString(record.conditionId) &&
		(record.workId === undefined || isNonEmptyString(record.workId)) &&
		isNonEmptyString(record.kind) &&
		isNonEmptyString(record.dismissedAt)
	);
}

function isV2Verdict(value: unknown): value is VerdictRecord {
	if (!isVerdict(value) || typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (
		typeof record.missionId !== "string" ||
		typeof record.governingMandateId !== "string" ||
		typeof record.issuedByParticipantId !== "string"
	) {
		return false;
	}
	// Retry decisions require both the handoff and the successor assignment; other decisions must
	// never carry either. Malformed records fail closed instead of projecting an ambiguous retry state.
	if (record.decision === "retry") {
		return isRetryHandoff(record.retryHandoff) && isCompleteSuccessorAssignment(record.successorAssignment);
	}
	return record.retryHandoff === undefined && record.successorAssignment === undefined;
}

// The persisted successor assignment must be as complete as the Verdict tool's creation-time fence
// (khala-verdict-support isCompleteAssignment); isKhalaWork alone accepts empty criteria arrays.
function isCompleteSuccessorAssignment(value: unknown): value is KhalaWork {
	if (!isKhalaWork(value)) {
		return false;
	}
	return (
		value.title.trim().length > 0 &&
		value.objective.trim().length > 0 &&
		value.scope.trim().length > 0 &&
		value.acceptanceCriteria.length > 0 &&
		value.acceptanceCriteria.every((item) => item.trim().length > 0) &&
		value.plan.length > 0 &&
		value.plan.every((item) => item.trim().length > 0) &&
		value.validation.length > 0 &&
		value.validation.every((item) => item.trim().length > 0) &&
		value.constraints.every((item) => item.trim().length > 0)
	);
}

function isVerdictDeliveryStatus(value: unknown): value is VerdictDeliveryStatusValue {
	return value === "pending" || value === "delivered" || value === "failed";
}

function isVerdictDelivery(value: unknown): value is VerdictDeliveryRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.deliveryId === "string" &&
		typeof record.verdictId === "string" &&
		typeof record.workId === "string" &&
		typeof record.executionId === "string" &&
		isVerdictDecision(record.decision) &&
		typeof record.message === "string" &&
		isVerdictDeliveryStatus(record.status) &&
		(record.target === undefined || typeof record.target === "string") &&
		(record.launcher === undefined || typeof record.launcher === "string") &&
		(record.error === undefined || typeof record.error === "string") &&
		typeof record.createdAt === "string" &&
		(record.deliveredAt === undefined || typeof record.deliveredAt === "string")
	);
}

function isPullRequestStatus(value: unknown): value is PullRequestStatusValue {
	return (
		value === "reviewable" ||
		value === "draft" ||
		value === "open" ||
		value === "changes-requested" ||
		value === "merged" ||
		value === "closed"
	);
}

function isPullRequestRecord(value: unknown): value is PullRequestRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.pullRequestId === "string" &&
		typeof record.workId === "string" &&
		typeof record.missionId === "string" &&
		typeof record.executionId === "string" &&
		isPullRequestStatus(record.status) &&
		(record.url === undefined || typeof record.url === "string") &&
		(record.number === undefined ||
			(typeof record.number === "number" && Number.isInteger(record.number) && record.number > 0)) &&
		(record.sourceBranch === undefined || typeof record.sourceBranch === "string") &&
		(record.targetBranch === undefined || typeof record.targetBranch === "string") &&
		(record.planningCommit === undefined || typeof record.planningCommit === "string") &&
		(record.headCommit === undefined || typeof record.headCommit === "string") &&
		(record.mergeCommit === undefined || typeof record.mergeCommit === "string") &&
		isStringArray(record.changedFiles) &&
		typeof record.diffSummary === "string" &&
		isStringArray(record.validationResults) &&
		isStringArray(record.reviewFeedback) &&
		isStringArray(record.unresolvedGaps) &&
		(record.reviewer === undefined || typeof record.reviewer === "string") &&
		(record.relatedPullRequestUrl === undefined || typeof record.relatedPullRequestUrl === "string") &&
		(record.remoteConfirmedAt === undefined || typeof record.remoteConfirmedAt === "string") &&
		typeof record.recordedAt === "string"
	);
}

function isCoordinationPhase(value: unknown): value is CoordinationPhase {
	return (
		value === "decision" ||
		value === "override" ||
		value === "release" ||
		value === "invalidation" ||
		value === "resolution"
	);
}

function isCoordinationRelation(value: unknown): value is CoordinationRelation {
	return value === "dependency" || value === "peer-conflict";
}

function isCoordinationExecutionIdentityPolicy(value: unknown): value is CoordinationExecutionIdentityPolicyValue {
	return value === CoordinationExecutionIdentityPolicy.activeExecution;
}

function isCoordinationClassification(value: unknown): value is CoordinationClassification {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		isStringArray(record.observedFiles) &&
		isStringArray(record.observedModules) &&
		isStringArray(record.observedApis) &&
		isStringArray(record.observedContracts)
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Coordination guard validates phase-specific durable invariants in one fail-closed predicate.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Coordination guard keeps phase-specific durable invariants together.
function isCoordinationRecord(value: unknown): value is CoordinationRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const common =
		isNonEmptyString(record.coordinationId) &&
		isNonEmptyString(record.actionId) &&
		isCoordinationPhase(record.phase) &&
		isCoordinationRelation(record.relation) &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.missionId) &&
		isNonEmptyString(record.selectedWorkId) &&
		isNonEmptyString(record.selectedMissionId) &&
		isNonEmptyString(record.relatedWorkId) &&
		isNonEmptyString(record.relatedMissionId) &&
		isNonEmptyString(record.reason);
	if (!common) {
		return false;
	}
	if (
		record.relation === "dependency" &&
		!(
			isNonEmptyString(record.upstreamWorkId) &&
			isNonEmptyString(record.upstreamMissionId) &&
			isNonEmptyString(record.remote) &&
			isNonEmptyString(record.branch) &&
			isNonEmptyString(record.relatedExecutionId) &&
			record.relatedWorkId === record.upstreamWorkId &&
			record.relatedMissionId === record.upstreamMissionId &&
			record.relatedExecutionId === record.upstreamExecutionId &&
			record.selectedWorkId === record.upstreamWorkId &&
			record.selectedMissionId === record.upstreamMissionId &&
			record.selectedExecutionId === record.upstreamExecutionId
		)
	) {
		return false;
	}
	if (record.phase === "override" && !isNonEmptyString(record.userEntryId)) {
		return false;
	}
	if (record.phase === "release" && !isNonEmptyString(record.upstreamHead)) {
		return false;
	}
	if (record.phase === "invalidation") {
		const hasObservedRefEvidence =
			"replacementHead" in record &&
			isCoordinationRemoteObservation(record.remoteObservation) &&
			record.remoteObservation.remote === record.remote &&
			record.remoteObservation.branch === record.branch &&
			record.replacementHead === record.remoteObservation.headCommit &&
			record.causedByCoordinationId === undefined;
		const hasTransitiveCause =
			!("replacementHead" in record) &&
			record.remoteObservation === undefined &&
			isNonEmptyString(record.causedByCoordinationId);
		if (
			!(
				isNonEmptyString(record.upstreamHead) &&
				isCoordinationDependents(record.affectedDependents) &&
				(hasObservedRefEvidence || hasTransitiveCause)
			)
		) {
			return false;
		}
	}
	if (record.phase === "resolution" && record.resolution !== "released" && record.resolution !== "terminal-failure") {
		return false;
	}
	if (
		record.phase === "resolution" &&
		record.resolution === "terminal-failure" &&
		!isNonEmptyString(record.resolutionEvidenceRecordId)
	) {
		return false;
	}
	return (
		(record.executionId === undefined || isNonEmptyString(record.executionId)) &&
		(record.selectedExecutionId === undefined || isNonEmptyString(record.selectedExecutionId)) &&
		(record.relatedExecutionId === undefined || isNonEmptyString(record.relatedExecutionId)) &&
		(record.upstreamExecutionId === undefined || isNonEmptyString(record.upstreamExecutionId)) &&
		(record.relation !== "peer-conflict" ||
			(record.selectedWorkId === record.workId && record.selectedMissionId === record.missionId) ||
			(record.selectedWorkId === record.relatedWorkId && record.selectedMissionId === record.relatedMissionId)) &&
		(record.upstreamHead === undefined || isNonEmptyString(record.upstreamHead)) &&
		(record.replacementHead === null ||
			record.replacementHead === undefined ||
			isNonEmptyString(record.replacementHead)) &&
		(record.causedByCoordinationId === undefined ||
			(record.phase === "invalidation" && isNonEmptyString(record.causedByCoordinationId))) &&
		coordinationPriorityBindingValid(record) &&
		(record.releasedExecutionId === undefined || isNonEmptyString(record.releasedExecutionId)) &&
		(record.resolutionEvidenceRecordId === undefined || isNonEmptyString(record.resolutionEvidenceRecordId)) &&
		(record.classification === undefined || isCoordinationClassification(record.classification)) &&
		(record.remoteObservation === undefined || isCoordinationRemoteObservation(record.remoteObservation)) &&
		(record.affectedDependents === undefined || isCoordinationDependents(record.affectedDependents)) &&
		coordinationExecutionIdentityPolicyValid(record)
	);
}

function coordinationExecutionIdentityPolicyValid(record: GuardRecord): boolean {
	const policy = (record as { peerConflictExecutionIdentityPolicy?: unknown }).peerConflictExecutionIdentityPolicy;
	if (policy === undefined) {
		return true;
	}
	return (
		record.relation === "peer-conflict" &&
		(record.phase === "decision" || record.phase === "override") &&
		isCoordinationExecutionIdentityPolicy(policy)
	);
}

function coordinationPriorityBindingValid(record: GuardRecord): boolean {
	if (record.phase === "override") {
		return isNonEmptyString(record.priorityId) && isNonEmptyString(record.userEntryId);
	}
	return record.priorityId === undefined && record.userEntryId === undefined;
}

function isCoordinationDependents(value: unknown): value is readonly CoordinationDependent[] {
	return (
		Array.isArray(value) &&
		value.every((item) => {
			if (typeof item !== "object" || item === null) {
				return false;
			}
			const record = item as GuardRecord;
			return (
				isNonEmptyString(record.workId) &&
				isNonEmptyString(record.missionId) &&
				(record.executionId === undefined || isNonEmptyString(record.executionId)) &&
				isNonEmptyString(record.supersededHead)
			);
		})
	);
}

function isCoordinationRemoteObservation(value: unknown): value is CoordinationRemoteObservation {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		isNonEmptyString(record.remote) &&
		isNonEmptyString(record.branch) &&
		(record.headCommit === null || isNonEmptyString(record.headCommit)) &&
		isNonEmptyString(record.observedAt)
	);
}

function isInterventionCategory(value: unknown): value is InterventionFailureCategory {
	return (
		value === "scope" ||
		value === "constraint" ||
		value === "acceptance" ||
		value === "plan" ||
		value === "validation" ||
		value === "no-progress" ||
		value === "unsafe-assumption" ||
		value === "budget" ||
		value === "dependency" ||
		value === "other"
	);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Intervention guard validates issuance and runtime-loss outcome invariants together.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Intervention guard keeps shared identity validation together.
function isInterventionRecord(value: unknown): value is InterventionRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	const common =
		isNonEmptyString(record.interventionId) &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.mandateId) &&
		isNonEmptyString(record.missionId) &&
		isNonEmptyString(record.executionId) &&
		isNonEmptyString(record.conclaveParticipantId) &&
		isNonEmptyString(record.executorParticipantId) &&
		isNonEmptyString(record.piSessionId) &&
		isNonEmptyString(record.assessmentId) &&
		isNonEmptyString(record.failureSummary) &&
		isInterventionCategory(record.category) &&
		isNonEmptyString(record.missionTerm) &&
		isNonEmptyString(record.message) &&
		(record.messageSha256 === undefined ||
			(typeof record.messageSha256 === "string" && SHA256_PATTERN.test(record.messageSha256))) &&
		isPromptIdentity(record.promptIdentity) &&
		isNonEmptyString(record.actionId);
	if (
		!common ||
		(record.category === "other" && GENERIC_INTERVENTION_SUMMARY_PATTERN.test(String(record.failureSummary).trim()))
	) {
		return false;
	}
	if (record.phase === "issuance") {
		return (
			(record.mode === "correction" || record.mode === "stop") &&
			isNonEmptyStringArray(record.piEntryIds) &&
			isNonEmptyString(record.sentAt) &&
			record.transportResult === "confirmed"
		);
	}
	if (
		record.phase !== "outcome" ||
		(record.outcome !== "resolved" &&
			record.outcome !== "partially-resolved" &&
			record.outcome !== "ignored" &&
			record.outcome !== "escalated") ||
		!isNonEmptyString(record.reason)
	) {
		return false;
	}
	const hasRuntimeFailure = isNonEmptyString(record.failedExecutionRecordId);
	const evidenceValid =
		(hasRuntimeFailure &&
			record.outcome === "escalated" &&
			(!Array.isArray(record.observedEntryIds) || record.observedEntryIds.length === 0)) ||
		(!hasRuntimeFailure && isNonEmptyStringArray(record.observedEntryIds));
	return (
		evidenceValid &&
		(record.resultingSignalId === undefined || isNonEmptyString(record.resultingSignalId)) &&
		(record.resultingVerdictId === undefined || isNonEmptyString(record.resultingVerdictId)) &&
		(record.resultingCoordinationId === undefined || isNonEmptyString(record.resultingCoordinationId)) &&
		(record.resultingExecutionId === undefined || isNonEmptyString(record.resultingExecutionId))
	);
}

function isUserPriorityProvenance(value: unknown): value is UserPriorityProvenance {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const provenance = value as Readonly<{ sessionId?: unknown; entryId?: unknown; contentSha256?: unknown }>;
	return (
		isNonEmptyString(provenance.sessionId) &&
		isNonEmptyString(provenance.entryId) &&
		typeof provenance.contentSha256 === "string" &&
		SHA256_PATTERN.test(provenance.contentSha256)
	);
}

function isUserPriorityStatus(value: unknown): value is UserPriorityStatusValue {
	return value === UserPriorityStatus.pending || value === UserPriorityStatus.ignored;
}

function sameUserPriorityImmutableEvidence(
	priority: UserPriorityRecord,
	prior: {
		workId: string;
		selectedWorkId: string;
		relatedWorkId: string;
		coordinationId: string;
		actionId: string;
		stopActionId: string;
		reason: string;
		entryId: string;
		sessionId: string;
		contentSha256: string;
		createdAt: string;
	},
): boolean {
	return (
		priority.workId === prior.workId &&
		priority.selectedWorkId === prior.selectedWorkId &&
		priority.relatedWorkId === prior.relatedWorkId &&
		priority.coordinationId === prior.coordinationId &&
		priority.actionId === prior.actionId &&
		priority.stopActionId === prior.stopActionId &&
		priority.reason === prior.reason &&
		priority.provenance.entryId === prior.entryId &&
		priority.provenance.sessionId === prior.sessionId &&
		priority.provenance.contentSha256 === prior.contentSha256 &&
		priority.createdAt === prior.createdAt
	);
}

function isUserPriorityEnforcementPhase(value: unknown): value is UserPriorityEnforcementPhaseValue {
	return (
		value === UserPriorityEnforcementPhase.prepared ||
		value === UserPriorityEnforcementPhase.baseline ||
		value === UserPriorityEnforcementPhase.handoff ||
		value === UserPriorityEnforcementPhase.enforced ||
		value === UserPriorityEnforcementPhase.terminal
	);
}

function isUserPriorityEnforcementRecord(value: unknown): value is UserPriorityEnforcementRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (!isUserPriorityEnforcementCommon(record)) {
		return false;
	}
	if (!isStringArray(record.baselineSignalIds)) {
		return false;
	}
	if (record.losingExecutionId === undefined) {
		return (
			record.phase === UserPriorityEnforcementPhase.enforced &&
			record.baselineSignalIds.length === 0 &&
			record.stopEntryIds === undefined &&
			record.interventionId === undefined &&
			record.blockedSignalId === undefined &&
			record.terminalExecutionRecordId === undefined
		);
	}
	return isUserPriorityEnforcementPhaseEvidenceValid(record);
}

function isUserPriorityEnforcementCommon(record: GuardRecord): boolean {
	return (
		isNonEmptyString(record.priorityId) &&
		isNonEmptyString(record.coordinationId) &&
		isNonEmptyString(record.workId) &&
		isNonEmptyString(record.selectedWorkId) &&
		isNonEmptyString(record.relatedWorkId) &&
		isNonEmptyString(record.losingWorkId) &&
		isNonEmptyString(record.losingMissionId) &&
		(record.losingExecutionId === undefined || isNonEmptyString(record.losingExecutionId)) &&
		typeof record.actionId === "string" &&
		USER_PRIORITY_ACTION_PATTERN.test(record.actionId) &&
		record.marker === `\u0000KHALA_SUPERVISION:stop:${record.actionId}:` &&
		isUserPriorityEnforcementPhase(record.phase) &&
		isStringArray(record.baselineSignalIds) &&
		new Set(record.baselineSignalIds).size === record.baselineSignalIds.length
	);
}

function isUserPriorityEnforcementPhaseEvidenceValid(record: GuardRecord): boolean {
	if (!isStringArray(record.baselineSignalIds)) {
		return false;
	}
	if (record.phase === UserPriorityEnforcementPhase.prepared) {
		return (
			record.baselineSignalIds.length === 0 &&
			record.stopEntryIds === undefined &&
			record.interventionId === undefined &&
			record.blockedSignalId === undefined &&
			record.terminalExecutionRecordId === undefined
		);
	}
	if (record.phase === UserPriorityEnforcementPhase.baseline) {
		return (
			record.stopEntryIds === undefined &&
			record.interventionId === undefined &&
			record.blockedSignalId === undefined &&
			record.terminalExecutionRecordId === undefined
		);
	}
	if (record.phase === UserPriorityEnforcementPhase.handoff) {
		return (
			isNonEmptyStringArray(record.stopEntryIds) &&
			record.interventionId === undefined &&
			record.blockedSignalId === undefined &&
			record.terminalExecutionRecordId === undefined
		);
	}
	if (record.phase === UserPriorityEnforcementPhase.enforced) {
		return (
			isNonEmptyStringArray(record.stopEntryIds) &&
			isNonEmptyString(record.interventionId) &&
			isNonEmptyString(record.blockedSignalId) &&
			record.terminalExecutionRecordId === undefined
		);
	}
	return (
		isNonEmptyString(record.terminalExecutionRecordId) &&
		record.blockedSignalId === undefined &&
		(record.stopEntryIds === undefined || isNonEmptyStringArray(record.stopEntryIds)) &&
		(record.interventionId === undefined || isNonEmptyString(record.interventionId))
	);
}

function isUserPriorityRecord(value: unknown): value is UserPriorityRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Readonly<{
		priorityId?: unknown;
		workId?: unknown;
		selectedWorkId?: unknown;
		relatedWorkId?: unknown;
		coordinationId?: unknown;
		actionId?: unknown;
		stopActionId?: unknown;
		reason?: unknown;
		provenance?: unknown;
		status?: unknown;
		createdAt?: unknown;
		ignoredAt?: unknown;
		ignoredReason?: unknown;
	}>;
	if (
		!(
			typeof record.priorityId === "string" &&
			USER_PRIORITY_ID_PATTERN.test(record.priorityId) &&
			isNonEmptyString(record.workId) &&
			isNonEmptyString(record.selectedWorkId) &&
			isNonEmptyString(record.relatedWorkId) &&
			record.selectedWorkId !== record.relatedWorkId &&
			isNonEmptyString(record.coordinationId) &&
			typeof record.actionId === "string" &&
			USER_PRIORITY_ACTION_PATTERN.test(record.actionId) &&
			typeof record.stopActionId === "string" &&
			USER_PRIORITY_ACTION_PATTERN.test(record.stopActionId) &&
			typeof record.reason === "string" &&
			record.reason.trim().length > 0 &&
			record.reason.length <= MAX_PRIORITY_REASON_LENGTH &&
			isUserPriorityProvenance(record.provenance) &&
			isUserPriorityStatus(record.status) &&
			isNonEmptyString(record.createdAt)
		)
	) {
		return false;
	}
	if (record.status === UserPriorityStatus.pending) {
		return record.ignoredAt === undefined && record.ignoredReason === undefined;
	}
	return isNonEmptyString(record.ignoredAt) && isNonEmptyString(record.ignoredReason);
}

function isWorkOutcomeRecord(value: unknown): value is WorkOutcomeRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.outcomeId === "string" &&
		typeof record.workId === "string" &&
		typeof record.mandateId === "string" &&
		typeof record.missionId === "string" &&
		typeof record.executionId === "string" &&
		typeof record.pullRequestId === "string" &&
		(record.pullRequestUrl === undefined || typeof record.pullRequestUrl === "string") &&
		(record.pullRequestNumber === undefined ||
			(typeof record.pullRequestNumber === "number" &&
				Number.isInteger(record.pullRequestNumber) &&
				record.pullRequestNumber > 0)) &&
		(record.sourceBranch === undefined || typeof record.sourceBranch === "string") &&
		(record.targetBranch === undefined || typeof record.targetBranch === "string") &&
		typeof record.finalHeadCommit === "string" &&
		typeof record.mergeCommit === "string" &&
		isStringArray(record.changedFiles) &&
		typeof record.diffSummary === "string" &&
		isStringArray(record.validationResults) &&
		isStringArray(record.reviewFeedback) &&
		isStringArray(record.unresolvedGaps) &&
		typeof record.acceptingActor === "string" &&
		typeof record.acceptedAt === "string"
	);
}

function isCounselRecord(value: unknown): value is CounselRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.workId === "string" &&
		(record.executionId === undefined || typeof record.executionId === "string") &&
		isStringArray(record.sourceRecordIds) &&
		isStringArray(record.observations) &&
		isStringArray(record.recommendations) &&
		isStringArray(record.uncertainties) &&
		typeof record.counselId === "string" &&
		(record.authorSession === undefined || typeof record.authorSession === "string") &&
		typeof record.createdAt === "string"
	);
}

function isLearningRecord(value: unknown): value is LearningRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.learningId === "string" &&
		typeof record.workId === "string" &&
		typeof record.executionId === "string" &&
		typeof record.observerName === "string" &&
		typeof record.topic === "string" &&
		typeof record.summary === "string" &&
		isStringArray(record.evidence) &&
		isStringArray(record.sourcePaths) &&
		typeof record.createdAt === "string"
	);
}

function isMandateRecord(value: unknown): value is MandateRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.mandateId === "string" &&
		typeof record.workId === "string" &&
		typeof record.revision === "number" &&
		Number.isInteger(record.revision) &&
		record.revision > 0 &&
		typeof record.sourceSubmissionRecordId === "string" &&
		isKhalaWork(record.terms) &&
		typeof record.admittedByParticipantId === "string" &&
		typeof record.admittedAt === "string"
	);
}

function isMissionRecord(value: unknown): value is MissionRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	return (
		typeof record.missionId === "string" &&
		typeof record.workId === "string" &&
		typeof record.mandateId === "string" &&
		(record.predecessorMissionId === undefined || isNonEmptyString(record.predecessorMissionId)) &&
		(record.causedByVerdictId === undefined || isNonEmptyString(record.causedByVerdictId)) &&
		(record.causedByCoordinationId === undefined || isNonEmptyString(record.causedByCoordinationId)) &&
		!(record.causedByVerdictId !== undefined && record.causedByCoordinationId !== undefined) &&
		((record.predecessorMissionId === undefined &&
			record.causedByVerdictId === undefined &&
			record.causedByCoordinationId === undefined) ||
			(record.predecessorMissionId !== undefined &&
				(record.causedByVerdictId !== undefined) !== (record.causedByCoordinationId !== undefined))) &&
		isKhalaWork(record.assignment) &&
		typeof record.assignedParticipantId === "string" &&
		typeof record.createdAt === "string"
	);
}

function coordinationReplayIdentity(
	record: KhalaArchiveRecord,
	payload: CoordinationRecord,
	includeExecutionIdentity = true,
): string {
	const primarySide: { workId: string; missionId: string; executionId?: string } = {
		workId: payload.workId,
		missionId: payload.missionId,
	};
	const relatedSide: { workId: string; missionId: string; executionId?: string } = {
		workId: payload.relatedWorkId,
		missionId: payload.relatedMissionId,
	};
	if (includeExecutionIdentity) {
		if (payload.executionId !== undefined) {
			primarySide.executionId = payload.executionId;
		}
		if (payload.relatedExecutionId !== undefined) {
			relatedSide.executionId = payload.relatedExecutionId;
		}
	}
	const sides = [primarySide, relatedSide].sort((left, right) =>
		JSON.stringify(left).localeCompare(JSON.stringify(right)),
	);
	let upstream: Readonly<Record<string, string | undefined>> | undefined;
	if (payload.relation === "dependency") {
		upstream = {
			workId: payload.upstreamWorkId,
			missionId: payload.upstreamMissionId,
			executionId: payload.upstreamExecutionId,
			remote: payload.remote,
			branch: payload.branch,
		};
	}
	return JSON.stringify({ projectPath: record.projectPath, relation: payload.relation, sides, upstream });
}

function samePriorityOverrideMissionBindings(
	override: CoordinationRecord,
	decision: CoordinationRecord,
	priority: {
		selectedWorkId: string;
		relatedWorkId: string;
	},
): boolean {
	let selectedMissionId = decision.relatedMissionId;
	let selectedExecutionId = override.relatedExecutionId;
	if (priority.selectedWorkId === decision.workId) {
		selectedMissionId = decision.missionId;
		selectedExecutionId = override.executionId;
	}
	const primaryExecutionMatches = decision.executionId === undefined || override.executionId === decision.executionId;
	const relatedExecutionMatches =
		decision.relatedExecutionId === undefined || override.relatedExecutionId === decision.relatedExecutionId;
	return (
		override.workId === decision.workId &&
		override.missionId === decision.missionId &&
		primaryExecutionMatches &&
		override.relatedWorkId === decision.relatedWorkId &&
		override.relatedMissionId === decision.relatedMissionId &&
		relatedExecutionMatches &&
		override.selectedWorkId === priority.selectedWorkId &&
		override.selectedMissionId === selectedMissionId &&
		override.selectedExecutionId === selectedExecutionId
	);
}

function priorityLosingBinding(
	override: CoordinationRecord,
	selectedWorkId: string,
): { workId: string; missionId: string; executionId?: string } {
	if (selectedWorkId === override.workId) {
		const result: { workId: string; missionId: string; executionId?: string } = {
			workId: override.relatedWorkId,
			missionId: override.relatedMissionId,
		};
		if (override.relatedExecutionId !== undefined) {
			result.executionId = override.relatedExecutionId;
		}
		return result;
	}
	const result: { workId: string; missionId: string; executionId?: string } = {
		workId: override.workId,
		missionId: override.missionId,
	};
	if (override.executionId !== undefined) {
		result.executionId = override.executionId;
	}
	return result;
}

function interventionReplayIdentity(record: KhalaArchiveRecord, payload: InterventionRecord): string {
	return JSON.stringify({
		projectPath: record.projectPath,
		workId: payload.workId,
		mandateId: payload.mandateId,
		missionId: payload.missionId,
		executionId: payload.executionId,
		conclaveParticipantId: payload.conclaveParticipantId,
		executorParticipantId: payload.executorParticipantId,
		piSessionId: payload.piSessionId,
		assessmentId: payload.assessmentId,
		failureSummary: payload.failureSummary,
		category: payload.category,
		missionTerm: payload.missionTerm,
		message: payload.message,
		promptIdentity: payload.promptIdentity,
	});
}

function activeExecutionIdForMission(
	latestExecutions: ReadonlyMap<string, ExecutorRecord>,
	workId: string,
	missionId: string,
): string | undefined {
	return [...latestExecutions.values()].find(
		(execution) =>
			execution.workId === workId &&
			execution.missionId === missionId &&
			(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
	)?.executionId;
}

function validatePeerConflictExecutionIdentities(
	coordination: CoordinationRecord,
	latestExecutions: ReadonlyMap<string, ExecutorRecord>,
): void {
	const primaryExecutionId = activeExecutionIdForMission(latestExecutions, coordination.workId, coordination.missionId);
	if (primaryExecutionId === undefined) {
		if (coordination.executionId !== undefined) {
			throw new Error(
				"Peer-conflict Coordination must omit the primary Execution identity when no active Execution exists.",
			);
		}
	} else if (coordination.executionId !== primaryExecutionId) {
		throw new Error("Peer-conflict Coordination requires the exact primary active Execution identity.");
	}
	const relatedExecutionId = activeExecutionIdForMission(
		latestExecutions,
		coordination.relatedWorkId,
		coordination.relatedMissionId,
	);
	if (relatedExecutionId === undefined) {
		if (coordination.relatedExecutionId !== undefined) {
			throw new Error(
				"Peer-conflict Coordination must omit the related Execution identity when no active Execution exists.",
			);
		}
	} else if (coordination.relatedExecutionId !== relatedExecutionId) {
		throw new Error("Peer-conflict Coordination requires the exact related active Execution identity.");
	}
	const selectedExecutionId = activeExecutionIdForMission(
		latestExecutions,
		coordination.selectedWorkId,
		coordination.selectedMissionId,
	);
	if (selectedExecutionId === undefined) {
		if (coordination.selectedExecutionId !== undefined) {
			throw new Error(
				"Peer-conflict Coordination must omit the selected Execution identity when no active Execution exists.",
			);
		}
	} else if (coordination.selectedExecutionId !== selectedExecutionId) {
		throw new Error("Peer-conflict Coordination requires the exact selected active Execution identity.");
	}
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Replay validation must inspect all supervision phases in append order.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Replay validation keeps append-order fences together.
function validateArchiveReplay(records: readonly KhalaArchiveRecord[]): void {
	const actions = new Map<string, string>();
	const coordinationGroups = new Map<
		string,
		{ decision: boolean; released: boolean; resolved: boolean; identity: string; missionIdentity: string }
	>();
	const interventionGroups = new Map<string, { issuance: boolean; outcome: boolean; identity: string }>();
	const coordinationInvalidations = new Map<string, CoordinationRecord>();
	const submissionWorkIds = new Set<string>();
	const userPriorityState = new Map<
		string,
		{
			status: UserPriorityStatusValue;
			workId: string;
			selectedWorkId: string;
			relatedWorkId: string;
			coordinationId: string;
			actionId: string;
			stopActionId: string;
			reason: string;
			entryId: string;
			sessionId: string;
			contentSha256: string;
			createdAt: string;
		}
	>();
	const appliedPriorities = new Set<string>();
	const appliedPriorityOverrides = new Map<string, CoordinationRecord>();
	const coordinationDecisions = new Map<string, CoordinationRecord>();
	const latestExecutorRecords = new Map<string, ExecutorRecord>();
	const priorityEnforcementState = new Map<
		string,
		{
			coordinationId: string;
			workId: string;
			selectedWorkId: string;
			relatedWorkId: string;
			losingWorkId: string;
			losingMissionId: string;
			losingExecutionId?: string;
			actionId: string;
			marker: string;
			phase: UserPriorityEnforcementPhaseValue;
			baselineSignalIds: readonly string[];
		}
	>();
	const signalRecords = new Map<string, SignalRecord>();
	const interventionIssuances = new Map<string, InterventionIssuanceRecord>();
	const terminalExecutionRecords = new Map<string, ExecutorRecord>();
	const submissionRecordWorkIds = new Map<string, string>();
	const wakeIds = new Set<string>();
	const recoveryIds = new Set<string>();
	const workerActions = new Map<
		string,
		{ requestRecordId: string; request: UserWorkerActionRequest; outcome: boolean }
	>();
	const dismissalIds = new Set<string>();
	const recoveryClaims = new Map<
		string,
		{ submissionRecordId: string; workId: string; ownerId: string; attempt: number; leaseExpiresAt: string }
	>();
	const recoveriesBySubmission = new Map<
		string,
		{
			attempts: number;
			maxAttempts: number;
			exhausted: boolean;
			latestRecoveryId?: string;
			latestLeaseExpiresAt?: string;
			latestWakeStatus: ConclaveWakeStatusValue | undefined;
		}
	>();
	for (const record of records) {
		if (record.type === "execution" && isExecutorRecord(record.payload)) {
			latestExecutorRecords.set(record.payload.executionId, record.payload);
		}
		if (record.type === "signal" && isSignal(record.payload)) {
			signalRecords.set(record.payload.signalId, record.payload);
		}
		if (
			record.type === "execution" &&
			isExecutorRecord(record.payload) &&
			(record.payload.status === ExecutorStatus.failed || record.payload.status === ExecutorStatus.finished)
		) {
			terminalExecutionRecords.set(record.recordId, record.payload);
		}
		if (record.type === "submission" && isWorkSubmission(record.payload)) {
			if (record.payload.workId !== record.workId) {
				throw new Error(`Submission ${record.recordId} has inconsistent Archive bindings.`);
			}
			submissionWorkIds.add(record.workId);
			submissionRecordWorkIds.set(record.recordId, record.workId);
		}
		if (record.type === "user-worker-action" && isUserWorkerActionRecord(record.payload)) {
			const action = record.payload;
			if (action.workId !== record.workId) {
				throw new Error(`User Worker action ${action.actionId} has inconsistent Archive bindings.`);
			}
			if (action.phase === "request") {
				if (workerActions.has(action.actionId)) {
					throw new Error(`User Worker action ${action.actionId} has duplicate requests.`);
				}
				workerActions.set(action.actionId, { requestRecordId: record.recordId, request: action, outcome: false });
			} else {
				const request = workerActions.get(action.actionId);
				if (
					request === undefined ||
					action.requestRecordId !== request.requestRecordId ||
					request.outcome ||
					action.kind !== request.request.kind ||
					action.conditionId !== request.request.conditionId ||
					action.workId !== request.request.workId
				) {
					throw new Error(`User Worker action ${action.actionId} has an invalid outcome sequence.`);
				}
				request.outcome = true;
			}
		}
		if (record.type === "attention-dismissal" && isAttentionDismissalRecord(record.payload)) {
			const dismissal = record.payload;
			if (dismissal.workId !== undefined && dismissal.workId !== record.workId) {
				throw new Error(`Attention dismissal ${dismissal.dismissalId} has inconsistent Archive bindings.`);
			}
			if (dismissalIds.has(dismissal.dismissalId)) {
				throw new Error(`Attention dismissal ${dismissal.dismissalId} is duplicated.`);
			}
			dismissalIds.add(dismissal.dismissalId);
		}
		if (record.type === "conclave-recovery" && isConclaveRecoveryRecord(record.payload)) {
			const recovery = record.payload;
			if (
				recovery.workId !== record.workId ||
				submissionRecordWorkIds.get(recovery.submissionRecordId) !== record.workId
			) {
				throw new Error(`Conclave recovery ${recovery.recoveryId} has inconsistent Archive bindings.`);
			}
			let state = recoveriesBySubmission.get(recovery.submissionRecordId);
			if (state === undefined) {
				state = {
					attempts: 0,
					maxAttempts: recovery.maxAttempts,
					exhausted: false,
					latestWakeStatus: undefined,
				};
				recoveriesBySubmission.set(recovery.submissionRecordId, state);
			}
			if (state.maxAttempts !== recovery.maxAttempts || state.exhausted) {
				throw new Error(`Conclave recovery ${recovery.recoveryId} has invalid retry state.`);
			}
			if (recovery.status === ConclaveRecoveryStatus.claimed) {
				// A successful wake records delivery, not a terminal Work decision. Recovery
				// eligibility checks the current Mission and active Execution before allowing
				// another bounded claim when delivery did not produce durable progress.
				const previousAttemptSettled =
					state.attempts === 0 ||
					state.latestWakeStatus === ConclaveWakeStatus.failed ||
					state.latestWakeStatus === ConclaveWakeStatus.woken ||
					(state.latestLeaseExpiresAt !== undefined &&
						Date.parse(record.recordedAt) >= Date.parse(state.latestLeaseExpiresAt));
				if (
					recoveryIds.has(recovery.recoveryId) ||
					recovery.attempt !== state.attempts + 1 ||
					!previousAttemptSettled ||
					!isRecoveryTimestampNearRecord(record.recordedAt, recovery.claimedAt) ||
					!isRecoveryLeaseBoundedFromRecord(record.recordedAt, recovery.leaseExpiresAt)
				) {
					throw new Error(`Conclave recovery ${recovery.recoveryId} has an invalid attempt sequence.`);
				}
				recoveryIds.add(recovery.recoveryId);
				state.attempts = recovery.attempt;
				state.latestRecoveryId = recovery.recoveryId;
				state.latestLeaseExpiresAt = recovery.leaseExpiresAt;
				state.latestWakeStatus = undefined;
				recoveryClaims.set(recovery.recoveryId, {
					submissionRecordId: recovery.submissionRecordId,
					workId: recovery.workId,
					ownerId: recovery.ownerId,
					attempt: recovery.attempt,
					leaseExpiresAt: recovery.leaseExpiresAt,
				});
			} else if (recovery.status === ConclaveRecoveryStatus.renewed) {
				const claim = recoveryClaims.get(recovery.recoveryId);
				if (
					claim === undefined ||
					wakeIds.has(recovery.recoveryId) ||
					claim.submissionRecordId !== recovery.submissionRecordId ||
					claim.workId !== recovery.workId ||
					claim.ownerId !== recovery.ownerId ||
					claim.attempt !== recovery.attempt ||
					state.attempts !== recovery.attempt ||
					state.latestRecoveryId !== recovery.recoveryId ||
					!isRecoveryTimestampNearRecord(record.recordedAt, recovery.renewedAt) ||
					!isRecoveryLeaseBoundedFromRecord(record.recordedAt, recovery.leaseExpiresAt) ||
					Date.parse(record.recordedAt) >= Date.parse(claim.leaseExpiresAt) ||
					Date.parse(recovery.renewedAt) >= Date.parse(claim.leaseExpiresAt) ||
					Date.parse(recovery.leaseExpiresAt) <= Date.parse(claim.leaseExpiresAt)
				) {
					throw new Error(`Conclave recovery ${recovery.recoveryId} has an invalid lease renewal.`);
				}
				claim.leaseExpiresAt = recovery.leaseExpiresAt;
				state.latestLeaseExpiresAt = recovery.leaseExpiresAt;
			} else {
				const finalAttemptSettled =
					state.latestWakeStatus === ConclaveWakeStatus.failed ||
					state.latestWakeStatus === ConclaveWakeStatus.woken ||
					(state.latestLeaseExpiresAt !== undefined &&
						Date.parse(record.recordedAt) >= Date.parse(state.latestLeaseExpiresAt));
				if (
					recoveryIds.has(recovery.recoveryId) ||
					state.attempts !== recovery.maxAttempts ||
					recovery.attempt !== state.attempts ||
					!finalAttemptSettled ||
					!isRecoveryTimestampNearRecord(record.recordedAt, recovery.exhaustedAt)
				) {
					throw new Error(`Conclave recovery ${recovery.recoveryId} exhausted before its retry limit.`);
				}
				recoveryIds.add(recovery.recoveryId);
				state.exhausted = true;
			}
		}
		if (record.type === "conclave-wake" && isConclaveWakeRecord(record.payload)) {
			if (record.payload.workId !== record.workId || !submissionWorkIds.has(record.workId)) {
				throw new Error(`Conclave wake ${record.payload.wakeId} has inconsistent Archive bindings.`);
			}
			if (wakeIds.has(record.payload.wakeId)) {
				throw new Error(`Conclave wake ${record.payload.wakeId} is duplicated.`);
			}
			wakeIds.add(record.payload.wakeId);
			const claim = recoveryClaims.get(record.payload.wakeId);
			if (claim !== undefined) {
				if (claim.workId !== record.workId) {
					throw new Error(`Conclave wake ${record.payload.wakeId} changed its recovery binding.`);
				}
				const state = recoveriesBySubmission.get(claim.submissionRecordId);
				if (state === undefined || state.exhausted || state.latestRecoveryId !== record.payload.wakeId) {
					throw new Error(`Conclave wake ${record.payload.wakeId} has invalid recovery ordering.`);
				}
				state.latestWakeStatus = record.payload.status;
			}
		}
		if (record.type === "coordination" && isCoordinationRecord(record.payload)) {
			const coordination = record.payload;
			if (
				record.payload.workId !== record.workId ||
				(record.executionId !== undefined && record.payload.executionId !== record.executionId)
			) {
				throw new Error(`Coordination ${record.payload.coordinationId} has inconsistent Archive bindings.`);
			}
			if (
				(coordination.phase === "decision" || coordination.phase === "override") &&
				coordination.relation === "peer-conflict" &&
				coordination.peerConflictExecutionIdentityPolicy === CoordinationExecutionIdentityPolicy.activeExecution
			) {
				validatePeerConflictExecutionIdentities(coordination, latestExecutorRecords);
			}
			if (coordination.phase === "override") {
				const { priorityId } = coordination;
				const decision = coordinationDecisions.get(coordination.coordinationId);
				let prior:
					| {
							status: UserPriorityStatusValue;
							coordinationId: string;
							selectedWorkId: string;
							relatedWorkId: string;
							actionId: string;
							stopActionId: string;
							entryId: string;
					  }
					| undefined;
				if (priorityId !== undefined) {
					prior = userPriorityState.get(priorityId);
				}
				if (
					decision !== undefined &&
					coordination.peerConflictExecutionIdentityPolicy !== decision.peerConflictExecutionIdentityPolicy
				) {
					throw new Error(
						`Coordination ${record.payload.coordinationId} changed its peer-conflict execution identity policy.`,
					);
				}
				if (
					priorityId === undefined ||
					prior === undefined ||
					prior.status !== UserPriorityStatus.pending ||
					appliedPriorities.has(priorityId) ||
					coordination.coordinationId !== prior.coordinationId ||
					coordination.actionId !== prior.actionId ||
					decision === undefined ||
					coordination.peerConflictExecutionIdentityPolicy !== decision.peerConflictExecutionIdentityPolicy ||
					coordination.selectedWorkId !== prior.selectedWorkId ||
					coordination.userEntryId !== prior.entryId ||
					!samePriorityOverrideMissionBindings(coordination, decision, prior) ||
					!(
						(coordination.workId === prior.selectedWorkId && coordination.relatedWorkId === prior.relatedWorkId) ||
						(coordination.workId === prior.relatedWorkId && coordination.relatedWorkId === prior.selectedWorkId)
					)
				) {
					throw new Error(
						`Coordination ${record.payload.coordinationId} references an invalid or already-applied User Priority.`,
					);
				}
				appliedPriorities.add(priorityId);
			}
			if (coordination.phase === "invalidation" && coordination.causedByCoordinationId !== undefined) {
				const cause = coordinationInvalidations.get(coordination.causedByCoordinationId);
				const adjacentDependent = cause?.affectedDependents?.some(
					(dependent) =>
						dependent.workId === coordination.upstreamWorkId &&
						dependent.missionId === coordination.upstreamMissionId &&
						dependent.executionId === coordination.upstreamExecutionId,
				);
				if (
					cause === undefined ||
					cause.workId !== coordination.upstreamWorkId ||
					cause.missionId !== coordination.upstreamMissionId ||
					cause.executionId !== coordination.upstreamExecutionId ||
					adjacentDependent !== true
				) {
					throw new Error(
						`Coordination ${record.payload.coordinationId} has an unrelated transitive invalidation cause.`,
					);
				}
			}
			const action = JSON.stringify({
				envelope: {
					schemaVersion: record.schemaVersion,
					type: record.type,
					projectPath: record.projectPath,
					workId: record.workId,
					executionId: record.executionId,
				},
				payload: record.payload,
			});
			const existingAction = actions.get(record.payload.actionId);
			if (existingAction !== undefined && existingAction !== action) {
				throw new Error(`Coordination action ${record.payload.actionId} was replayed with different evidence.`);
			}
			actions.set(record.payload.actionId, action);
			const identity = coordinationReplayIdentity(record, record.payload);
			let group = coordinationGroups.get(record.payload.coordinationId);
			const missionIdentity = coordinationReplayIdentity(record, record.payload, false);
			if (group === undefined) {
				group = { decision: false, released: false, resolved: false, identity, missionIdentity };
				coordinationGroups.set(record.payload.coordinationId, group);
			} else if (
				group.identity !== identity &&
				// An override snapshots current Execution identities; its Mission pair remains decision-bound.
				!(record.payload.phase === "override" && group.missionIdentity === missionIdentity)
			) {
				throw new Error(`Coordination ${record.payload.coordinationId} changed its identity bindings.`);
			}
			if (record.payload.phase === "decision") {
				coordinationDecisions.set(record.payload.coordinationId, record.payload);
				if (group.decision) {
					throw new Error(`Coordination ${record.payload.coordinationId} has duplicate decisions.`);
				}
				if (group.released || group.resolved) {
					throw new Error(`Coordination ${record.payload.coordinationId} has an invalid decision order.`);
				}
				group.decision = true;
			} else if (!group.decision || group.resolved || (group.released && record.payload.phase !== "resolution")) {
				throw new Error(`Coordination ${record.payload.coordinationId} has an invalid phase order.`);
			} else if (record.payload.phase === "release") {
				if (group.released) {
					throw new Error(`Coordination ${record.payload.coordinationId} has duplicate releases.`);
				}
				group.released = true;
			} else if (record.payload.phase === "resolution") {
				if (group.resolved || (record.payload.resolution === "released" && !group.released)) {
					throw new Error(`Coordination ${record.payload.coordinationId} has an invalid resolution.`);
				}
				group.resolved = true;
			}
			if (record.payload.phase === "invalidation") {
				coordinationInvalidations.set(record.payload.coordinationId, record.payload);
			}
			if (record.payload.phase === "override" && record.payload.priorityId !== undefined) {
				appliedPriorityOverrides.set(record.payload.priorityId, record.payload);
			}
		}
		if (record.type === "intervention" && isInterventionRecord(record.payload)) {
			if (
				record.payload.workId !== record.workId ||
				(record.executionId !== undefined && record.payload.executionId !== record.executionId)
			) {
				throw new Error(`Intervention ${record.payload.interventionId} has inconsistent Archive bindings.`);
			}
			const action = JSON.stringify({
				envelope: {
					schemaVersion: record.schemaVersion,
					type: record.type,
					projectPath: record.projectPath,
					workId: record.workId,
					executionId: record.executionId,
				},
				payload: record.payload,
			});
			const existingAction = actions.get(record.payload.actionId);
			if (existingAction !== undefined && existingAction !== action) {
				throw new Error(`Intervention action ${record.payload.actionId} was replayed with different evidence.`);
			}
			actions.set(record.payload.actionId, action);
			const identity = interventionReplayIdentity(record, record.payload);
			let group = interventionGroups.get(record.payload.interventionId);
			if (group === undefined) {
				group = { issuance: false, outcome: false, identity };
				interventionGroups.set(record.payload.interventionId, group);
			} else if (group.identity !== identity) {
				throw new Error(`Intervention ${record.payload.interventionId} changed its identity bindings.`);
			}
			if (record.payload.phase === "issuance") {
				interventionIssuances.set(record.payload.interventionId, record.payload);
				if (group.issuance || group.outcome) {
					throw new Error(`Intervention ${record.payload.interventionId} has invalid issuance order.`);
				}
				group.issuance = true;
			} else if (!group.issuance || group.outcome) {
				throw new Error(`Intervention ${record.payload.interventionId} has an invalid outcome order.`);
			} else {
				group.outcome = true;
			}
		}
		if (record.type === "user-priority" && isUserPriorityRecord(record.payload)) {
			const priority = record.payload;
			if (priority.workId !== record.workId || priority.selectedWorkId !== record.workId) {
				throw new Error(`User Priority ${priority.priorityId} has inconsistent Archive bindings.`);
			}
			const prior = userPriorityState.get(priority.priorityId);
			if (prior === undefined) {
				if (priority.status !== UserPriorityStatus.pending) {
					throw new Error(`User Priority ${priority.priorityId} must start as pending.`);
				}
				userPriorityState.set(priority.priorityId, {
					status: priority.status,
					workId: priority.workId,
					selectedWorkId: priority.selectedWorkId,
					relatedWorkId: priority.relatedWorkId,
					coordinationId: priority.coordinationId,
					actionId: priority.actionId,
					stopActionId: priority.stopActionId,
					reason: priority.reason,
					entryId: priority.provenance.entryId,
					sessionId: priority.provenance.sessionId,
					contentSha256: priority.provenance.contentSha256,
					createdAt: priority.createdAt,
				});
			} else {
				if (
					prior.status !== UserPriorityStatus.pending ||
					priority.status !== UserPriorityStatus.ignored ||
					appliedPriorities.has(priority.priorityId) ||
					!sameUserPriorityImmutableEvidence(priority, prior)
				) {
					throw new Error(`User Priority ${priority.priorityId} has an invalid phase sequence.`);
				}
				userPriorityState.set(priority.priorityId, {
					...prior,
					status: priority.status,
				});
			}
		}
		if (record.type === "user-priority-enforcement" && isUserPriorityEnforcementRecord(record.payload)) {
			const enforcement = record.payload;
			if (enforcement.workId !== record.workId) {
				throw new Error(`User Priority enforcement ${enforcement.priorityId} has inconsistent Archive bindings.`);
			}
			const priority = userPriorityState.get(enforcement.priorityId);
			const override = appliedPriorityOverrides.get(enforcement.priorityId);
			let losing: ReturnType<typeof priorityLosingBinding> | undefined;
			if (override !== undefined) {
				losing = priorityLosingBinding(override, enforcement.selectedWorkId);
			}
			const expectedLosingWorkId = losing?.workId;
			const expectedLosingMissionId = losing?.missionId;
			const expectedLosingExecutionId = losing?.executionId;
			if (
				priority === undefined ||
				priority.status !== UserPriorityStatus.pending ||
				override === undefined ||
				!appliedPriorities.has(enforcement.priorityId) ||
				enforcement.coordinationId !== priority.coordinationId ||
				enforcement.workId !== priority.workId ||
				enforcement.selectedWorkId !== priority.selectedWorkId ||
				enforcement.relatedWorkId !== priority.relatedWorkId ||
				enforcement.actionId !== priority.stopActionId ||
				enforcement.losingWorkId !== expectedLosingWorkId ||
				enforcement.losingMissionId !== expectedLosingMissionId ||
				enforcement.losingExecutionId !== expectedLosingExecutionId
			) {
				throw new Error(`User Priority enforcement ${enforcement.priorityId} has forged target evidence.`);
			}
			const prior = priorityEnforcementState.get(enforcement.priorityId);
			if (prior === undefined) {
				if (
					(enforcement.losingExecutionId === undefined &&
						enforcement.phase !== UserPriorityEnforcementPhase.enforced) ||
					(enforcement.losingExecutionId !== undefined && enforcement.phase !== UserPriorityEnforcementPhase.prepared)
				) {
					throw new Error(`User Priority enforcement ${enforcement.priorityId} has an invalid initial phase.`);
				}
			} else {
				const sameIdentity =
					prior.coordinationId === enforcement.coordinationId &&
					prior.workId === enforcement.workId &&
					prior.selectedWorkId === enforcement.selectedWorkId &&
					prior.relatedWorkId === enforcement.relatedWorkId &&
					prior.losingWorkId === enforcement.losingWorkId &&
					prior.losingMissionId === enforcement.losingMissionId &&
					prior.losingExecutionId === enforcement.losingExecutionId &&
					prior.actionId === enforcement.actionId &&
					prior.marker === enforcement.marker;
				const validTransition =
					(prior.phase === UserPriorityEnforcementPhase.prepared &&
						(enforcement.phase === UserPriorityEnforcementPhase.baseline ||
							enforcement.phase === UserPriorityEnforcementPhase.terminal)) ||
					(prior.phase === UserPriorityEnforcementPhase.baseline &&
						(enforcement.phase === UserPriorityEnforcementPhase.handoff ||
							enforcement.phase === UserPriorityEnforcementPhase.terminal)) ||
					(prior.phase === UserPriorityEnforcementPhase.handoff &&
						(enforcement.phase === UserPriorityEnforcementPhase.enforced ||
							enforcement.phase === UserPriorityEnforcementPhase.terminal));
				const establishesBaseline =
					prior.phase === UserPriorityEnforcementPhase.prepared &&
					enforcement.phase === UserPriorityEnforcementPhase.baseline;
				const baselinePreserved =
					establishesBaseline || sameStringArray(prior.baselineSignalIds, enforcement.baselineSignalIds);
				if (!(sameIdentity && validTransition && baselinePreserved)) {
					throw new Error(`User Priority enforcement ${enforcement.priorityId} has an invalid phase sequence.`);
				}
			}
			if (enforcement.phase === UserPriorityEnforcementPhase.enforced && enforcement.losingExecutionId !== undefined) {
				let blockedSignal: SignalRecord | undefined;
				if (enforcement.blockedSignalId !== undefined) {
					blockedSignal = signalRecords.get(enforcement.blockedSignalId);
				}
				const baselineSignalIds = new Set(enforcement.baselineSignalIds);
				const newTargetSignals = [...signalRecords.values()].filter(
					(signal) =>
						signal.workId === enforcement.losingWorkId &&
						signal.missionId === enforcement.losingMissionId &&
						signal.executionId === enforcement.losingExecutionId &&
						!baselineSignalIds.has(signal.signalId),
				);
				if (
					blockedSignal === undefined ||
					blockedSignal.workId !== enforcement.losingWorkId ||
					blockedSignal.missionId !== enforcement.losingMissionId ||
					blockedSignal.executionId !== enforcement.losingExecutionId ||
					blockedSignal.kind !== "blocked" ||
					blockedSignal.evidence.length === 0 ||
					newTargetSignals.length !== 1 ||
					newTargetSignals[0]?.signalId !== enforcement.blockedSignalId
				) {
					throw new Error(
						`User Priority enforcement ${enforcement.priorityId} lacks one causal current blocked Signal.`,
					);
				}
				let issuance: InterventionIssuanceRecord | undefined;
				if (enforcement.interventionId !== undefined) {
					issuance = interventionIssuances.get(enforcement.interventionId);
				}
				if (
					issuance === undefined ||
					issuance.actionId !== enforcement.actionId ||
					issuance.mode !== "stop" ||
					issuance.workId !== enforcement.losingWorkId ||
					issuance.executionId !== enforcement.losingExecutionId
				) {
					throw new Error(
						`User Priority enforcement ${enforcement.priorityId} lacks its deterministic stop Intervention.`,
					);
				}
			}
			if (enforcement.phase === UserPriorityEnforcementPhase.terminal) {
				let terminal: ExecutorRecord | undefined;
				if (enforcement.terminalExecutionRecordId !== undefined) {
					terminal = terminalExecutionRecords.get(enforcement.terminalExecutionRecordId);
				}
				if (
					terminal === undefined ||
					terminal.executionId !== enforcement.losingExecutionId ||
					terminal.workId !== enforcement.losingWorkId ||
					(terminal.status !== ExecutorStatus.failed && terminal.status !== ExecutorStatus.finished)
				) {
					throw new Error(
						`User Priority enforcement ${enforcement.priorityId} lacks durable terminal Execution evidence.`,
					);
				}
			}
			const nextState: {
				coordinationId: string;
				workId: string;
				selectedWorkId: string;
				relatedWorkId: string;
				losingWorkId: string;
				losingMissionId: string;
				losingExecutionId?: string;
				actionId: string;
				marker: string;
				phase: UserPriorityEnforcementPhaseValue;
				baselineSignalIds: readonly string[];
			} = {
				coordinationId: enforcement.coordinationId,
				workId: enforcement.workId,
				selectedWorkId: enforcement.selectedWorkId,
				relatedWorkId: enforcement.relatedWorkId,
				losingWorkId: enforcement.losingWorkId,
				losingMissionId: enforcement.losingMissionId,
				actionId: enforcement.actionId,
				marker: enforcement.marker,
				phase: enforcement.phase,
				baselineSignalIds: enforcement.baselineSignalIds,
			};
			if (enforcement.losingExecutionId !== undefined) {
				nextState.losingExecutionId = enforcement.losingExecutionId;
			}
			priorityEnforcementState.set(enforcement.priorityId, nextState);
		}
	}
}

export type {
	ArchiveRecordType,
	ArchiveSchemaVersion,
	AttentionDismissalRecord,
	ConclaveRecoveryClaimRecord,
	ConclaveRecoveryExhaustedRecord,
	ConclaveRecoveryRecord,
	ConclaveRecoveryRenewalRecord,
	ConclaveWakeFailure,
	ConclaveWakeRecord,
	ConclaveWakeRecovery,
	ConclaveWakeStatusValue,
	CoordinationClassification,
	CoordinationDependent,
	CoordinationExecutionIdentityPolicyValue,
	CoordinationPhase,
	CoordinationRecord,
	CoordinationRelation,
	CoordinationRemoteObservation,
	CoordinationResolution,
	CounselRecord,
	ExecutionPurpose,
	ExecutorFailureCategory,
	ExecutorKind,
	ExecutorPromptIdentity,
	ExecutorRecord,
	ExecutorStatusValue,
	InterventionFailureCategory,
	InterventionIssuanceRecord,
	InterventionMode,
	InterventionOutcomeKind,
	InterventionOutcomeRecord,
	InterventionRecord,
	KhalaArchiveAppend,
	KhalaArchiveRecord,
	KhalaWork,
	KhalaWorkSubmission,
	LearningRecord,
	MandateRecord,
	MissionAssignment,
	MissionRecord,
	PullRequestRecord,
	PullRequestStatusValue,
	RetryHandoff,
	SignalKind,
	SignalRecord,
	UpstreamExecutionBase,
	UserModelRecoveryRecord,
	UserPriorityEnforcementPhaseValue,
	UserPriorityEnforcementRecord,
	UserPriorityProvenance,
	UserPriorityRecord,
	UserPriorityStatusValue,
	UserWorkerActionKind,
	UserWorkerActionOutcome,
	UserWorkerActionRecord,
	UserWorkerActionRequest,
	VerdictDecision,
	VerdictDeliveryRecord,
	VerdictDeliveryStatusValue,
	VerdictRecord,
	WorkCostBudget,
	WorkOutcomeRecord,
	WorkSubmissionRequest,
	WorkSubmissionStatusValue,
};
export {
	CONCLAVE_RECOVERY_CLAIM_LEASE_MS,
	ConclaveRecoveryStatus,
	ConclaveWakeStatus,
	CoordinationExecutionIdentityPolicy,
	EXECUTION_SCHEMA_VERSION,
	ExecutorStatus,
	isArchiveRecord,
	isAttentionDismissalRecord,
	isConclaveRecoveryRecord,
	isConclaveWakeRecord,
	isCoordinationClassification,
	isCoordinationRecord,
	isCounselRecord,
	isExecutionPurpose,
	isExecutorRecord,
	isInterventionRecord,
	isKhalaWork,
	isLearningRecord,
	isMandateRecord,
	isMissionExecutorRecord,
	isMissionRecord,
	isPromptIdentity,
	isPullRequestRecord,
	isSignal,
	isStringArray,
	isUpstreamExecutionBase,
	isUserModelRecoveryRecord,
	isUserPriorityEnforcementRecord,
	isUserPriorityRecord,
	isUserWorkerActionRecord,
	isV2ExecutorRecord,
	isV2Signal,
	isV2Verdict,
	isV2WorkSubmission,
	isV3ExecutorRecord,
	isVerdict,
	isVerdictDelivery,
	isWorkCostBudget,
	isWorkOutcomeRecord,
	isWorkSubmission,
	KhalaWorkEntryStatus,
	KhalaWorkLaunchStatus,
	MAX_PRIORITY_REASON_LENGTH,
	PullRequestStatus,
	UserPriorityEnforcementPhase,
	UserPriorityStatus,
	VerdictDeliveryStatus,
	validateArchiveReplay,
	WorkSubmissionStatus,
};
