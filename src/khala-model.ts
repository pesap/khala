// biome-ignore-all lint/style/noExcessiveLinesPerFile: The Khala schema is deliberately one authoritative file; each record's shape and its guard stay together.
// Khala data model.
//
// This file is the dependency leaf for durable Khala records. It contains no
// I/O and keeps every record shape beside its runtime guard.

// --- Archive envelope -------------------------------------------------------

type ArchiveSchemaVersion = 1 | 2;
type ArchiveRecordType =
	| "submission"
	| "conclave-wake"
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
	| "intervention";

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
	rejected: "rejected",
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
	status: ExecutorStatusValue;
	startedAt: string;
	lastSignalAt?: string;
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
	reason: string;
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
	}>;

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
	return isStringArray(value) && value.length > 0 && value.every((item) => item.trim().length > 0);
}

function isArchiveRecordType(value: unknown): value is ArchiveRecordType {
	return (
		value === "submission" ||
		value === "conclave-wake" ||
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
		value === "coordination" ||
		value === "intervention"
	);
}

function isArchiveSchemaVersion(value: unknown): value is ArchiveSchemaVersion {
	return value === 1 || value === 2;
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
	if (record.schemaVersion === 2 || isImplicitV2ArchiveRecordType(record.type)) {
		return isArchivePayloadV2(record.type, record.payload);
	}
	return isArchivePayloadLegacy(record.type, record.payload);
}

function isImplicitV2ArchiveRecordType(type: ArchiveRecordType): boolean {
	return (
		type === "verdict-delivery" ||
		type === "conclave-wake" ||
		type === "mandate" ||
		type === "mission" ||
		type === "pull-request" ||
		type === "work-outcome"
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

function isArchivePayloadV2(type: ArchiveRecordType, payload: unknown): boolean {
	if (type === "conclave-wake") {
		return isConclaveWakeRecord(payload);
	}
	if (type === "coordination") {
		return isCoordinationRecord(payload);
	}
	if (type === "intervention") {
		return isInterventionRecord(payload);
	}
	if (type === "submission") {
		return isV2WorkSubmission(payload);
	}
	if (type === "execution") {
		return isV2ExecutorRecord(payload);
	}
	if (type === "signal") {
		return isV2Signal(payload);
	}
	if (type === "counsel") {
		return isCounselRecord(payload);
	}
	if (type === "verdict") {
		return isV2Verdict(payload);
	}
	if (type === "learning") {
		return isLearningRecord(payload);
	}
	if (type === "verdict-delivery") {
		return isVerdictDelivery(payload);
	}
	if (type === "mandate") {
		return isMandateRecord(payload);
	}
	if (type === "mission") {
		return isMissionRecord(payload);
	}
	if (type === "pull-request") {
		return isPullRequestRecord(payload);
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
		(record.status === ExecutorStatus.starting ||
			record.status === ExecutorStatus.running ||
			record.status === ExecutorStatus.finished ||
			record.status === ExecutorStatus.failed) &&
		typeof record.startedAt === "string"
	);
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

function isV2ExecutorRecord(value: unknown): value is ExecutorRecord {
	if (!isExecutorRecord(value) || typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as GuardRecord;
	if (typeof record.participantId !== "string" || !isExecutionPurpose(record.purpose)) {
		return false;
	}
	if (record.purpose.kind === "mission") {
		if (record.kind === "observer" || record.missionId !== record.purpose.missionId) {
			return false;
		}
		if (record.status === ExecutorStatus.running) {
			return (
				isNonEmptyString(record.piSessionId) &&
				isNonEmptyString(record.sessionPath) &&
				isPromptIdentity(record.promptIdentity)
			);
		}
		return true;
	}
	return record.kind === "observer" && record.missionId === undefined;
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
	return record.decision !== "retry" || isKhalaWork(record.successorAssignment);
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
		(record.userEntryId === undefined || isNonEmptyString(record.userEntryId)) &&
		(record.releasedExecutionId === undefined || isNonEmptyString(record.releasedExecutionId)) &&
		(record.resolutionEvidenceRecordId === undefined || isNonEmptyString(record.resolutionEvidenceRecordId)) &&
		(record.classification === undefined || isCoordinationClassification(record.classification)) &&
		(record.remoteObservation === undefined || isCoordinationRemoteObservation(record.remoteObservation)) &&
		(record.affectedDependents === undefined || isCoordinationDependents(record.affectedDependents))
	);
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

function coordinationReplayIdentity(record: KhalaArchiveRecord, payload: CoordinationRecord): string {
	const sides = [
		{
			workId: payload.workId,
			missionId: payload.missionId,
			executionId: payload.executionId,
		},
		{
			workId: payload.relatedWorkId,
			missionId: payload.relatedMissionId,
			executionId: payload.relatedExecutionId,
		},
	].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Replay validation must inspect all supervision phases in append order.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Replay validation keeps append-order fences together.
function validateArchiveReplay(records: readonly KhalaArchiveRecord[]): void {
	const actions = new Map<string, string>();
	const coordinationGroups = new Map<
		string,
		{ decision: boolean; released: boolean; resolved: boolean; identity: string }
	>();
	const interventionGroups = new Map<string, { issuance: boolean; outcome: boolean; identity: string }>();
	const coordinationInvalidations = new Map<string, CoordinationRecord>();
	const submissionWorkIds = new Set<string>();
	const wakeIds = new Set<string>();
	for (const record of records) {
		if (record.type === "submission" && isWorkSubmission(record.payload)) {
			if (record.payload.workId !== record.workId) {
				throw new Error(`Submission ${record.recordId} has inconsistent Archive bindings.`);
			}
			submissionWorkIds.add(record.workId);
		}
		if (record.type === "conclave-wake" && isConclaveWakeRecord(record.payload)) {
			if (record.payload.workId !== record.workId || !submissionWorkIds.has(record.workId)) {
				throw new Error(`Conclave wake ${record.payload.wakeId} has inconsistent Archive bindings.`);
			}
			if (wakeIds.has(record.payload.wakeId)) {
				throw new Error(`Conclave wake ${record.payload.wakeId} is duplicated.`);
			}
			wakeIds.add(record.payload.wakeId);
		}
		if (record.type === "coordination" && isCoordinationRecord(record.payload)) {
			const coordination = record.payload;
			if (
				record.payload.workId !== record.workId ||
				(record.executionId !== undefined && record.payload.executionId !== record.executionId)
			) {
				throw new Error(`Coordination ${record.payload.coordinationId} has inconsistent Archive bindings.`);
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
			if (group === undefined) {
				group = { decision: false, released: false, resolved: false, identity };
				coordinationGroups.set(record.payload.coordinationId, group);
			} else if (group.identity !== identity) {
				throw new Error(`Coordination ${record.payload.coordinationId} changed its identity bindings.`);
			}
			if (record.payload.phase === "decision") {
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
	}
}

export type {
	ArchiveRecordType,
	ArchiveSchemaVersion,
	ConclaveWakeFailure,
	ConclaveWakeRecord,
	ConclaveWakeRecovery,
	ConclaveWakeStatusValue,
	CoordinationClassification,
	CoordinationDependent,
	CoordinationPhase,
	CoordinationRecord,
	CoordinationRelation,
	CoordinationRemoteObservation,
	CoordinationResolution,
	CounselRecord,
	ExecutionPurpose,
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
	ConclaveWakeStatus,
	ExecutorStatus,
	isArchiveRecord,
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
	isMissionRecord,
	isPromptIdentity,
	isPullRequestRecord,
	isSignal,
	isStringArray,
	isUpstreamExecutionBase,
	isV2ExecutorRecord,
	isV2Signal,
	isV2Verdict,
	isV2WorkSubmission,
	isVerdict,
	isVerdictDelivery,
	isWorkCostBudget,
	isWorkOutcomeRecord,
	isWorkSubmission,
	KhalaWorkEntryStatus,
	KhalaWorkLaunchStatus,
	PullRequestStatus,
	VerdictDeliveryStatus,
	validateArchiveReplay,
	WorkSubmissionStatus,
};
