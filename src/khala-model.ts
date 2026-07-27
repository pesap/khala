// biome-ignore-all lint/style/noExcessiveLinesPerFile: The Khala schema is deliberately one authoritative file; each record's shape and its guard stay together.
// Khala data model.
//
// This file is the dependency leaf for durable Khala records. It contains no
// I/O and keeps every record shape beside its runtime guard.

// --- Archive envelope -------------------------------------------------------

type ArchiveSchemaVersion = 1 | 2;
type ArchiveRecordType =
	| "submission"
	| "execution"
	| "signal"
	| "counsel"
	| "verdict"
	| "learning"
	| "mandate"
	| "mission";

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

type KhalaWork = Readonly<{
	title: string;
	objective: string;
	context: string;
	scope: string;
	acceptanceCriteria: readonly string[];
	constraints: readonly string[];
	plan: readonly string[];
	validation: readonly string[];
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
type KhalaWorkEntryStatusValue = (typeof KhalaWorkEntryStatus)[keyof typeof KhalaWorkEntryStatus];

const KhalaWorkLaunchStatus = {
	queued: "queued",
	starting: "starting",
	launched: "launched",
	rejected: "rejected",
} as const;
type KhalaWorkLaunchStatusValue = (typeof KhalaWorkLaunchStatus)[keyof typeof KhalaWorkLaunchStatus];

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

// --- Mandates and Missions --------------------------------------------------

type ParticipantRole = "user-session" | "maintainer" | "conclave" | "executor" | "observer" | "preserver";

type ParticipantIdentity = Readonly<{
	participantId: string;
	role: ParticipantRole;
	label: string;
}>;

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
	assignment: MissionAssignment;
	assignedParticipantId: string;
	createdAt: string;
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
	sessionPath?: string;
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
	successorAssignment?: MissionAssignment;
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
		workId?: unknown;
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
		successorAssignment?: unknown;
		learningId?: unknown;
		observerName?: unknown;
		topic?: unknown;
		sourcePaths?: unknown;
		createdAt?: unknown;
		sourceSubmissionRecordId?: unknown;
		terms?: unknown;
		revision?: unknown;
		admittedByParticipantId?: unknown;
		admittedAt?: unknown;
		predecessorMissionId?: unknown;
		causedByVerdictId?: unknown;
		assignment?: unknown;
		assignedParticipantId?: unknown;
		sourceRecordIds?: unknown;
		observations?: unknown;
		recommendations?: unknown;
		uncertainties?: unknown;
		counselId?: unknown;
		authorSession?: unknown;
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
		value === "execution" ||
		value === "signal" ||
		value === "counsel" ||
		value === "verdict" ||
		value === "learning" ||
		value === "mandate" ||
		value === "mission"
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
	if (record.schemaVersion === 2) {
		return isArchivePayloadV2(record.type, record.payload);
	}
	return isArchivePayloadLegacy(record.type, record.payload);
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
	if (type === "mandate") {
		return isMandateRecord(payload);
	}
	return isMissionRecord(payload);
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
		isStringArray(record.validation)
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
		if (record.kind === "observer") {
			return false;
		}
		return record.missionId === record.purpose.missionId;
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
		(record.successorAssignment === undefined || isKhalaWork(record.successorAssignment))
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
		(record.predecessorMissionId === undefined || typeof record.predecessorMissionId === "string") &&
		(record.causedByVerdictId === undefined || typeof record.causedByVerdictId === "string") &&
		isKhalaWork(record.assignment) &&
		typeof record.assignedParticipantId === "string" &&
		typeof record.createdAt === "string"
	);
}

export type {
	ArchiveRecordType,
	ArchiveSchemaVersion,
	CounselRecord,
	ExecutionPurpose,
	ExecutorKind,
	ExecutorRecord,
	ExecutorStatusValue,
	KhalaArchiveAppend,
	KhalaArchiveRecord,
	KhalaWork,
	KhalaWorkEntryStatusValue,
	KhalaWorkLaunchStatusValue,
	KhalaWorkSubmission,
	LearningRecord,
	MandateRecord,
	MissionAssignment,
	MissionRecord,
	ParticipantIdentity,
	ParticipantRole,
	SignalKind,
	SignalRecord,
	VerdictDecision,
	VerdictRecord,
	WorkSubmissionRequest,
	WorkSubmissionStatusValue,
};
export {
	ExecutorStatus,
	isArchiveRecord,
	isCounselRecord,
	isExecutionPurpose,
	isExecutorRecord,
	isKhalaWork,
	isLearningRecord,
	isMandateRecord,
	isMissionRecord,
	isNonEmptyStringArray,
	isSignal,
	isStringArray,
	isV2ExecutorRecord,
	isV2Signal,
	isV2Verdict,
	isV2WorkSubmission,
	isVerdict,
	isWorkSubmission,
	KhalaWorkEntryStatus,
	KhalaWorkLaunchStatus,
	WorkSubmissionStatus,
};
