// biome-ignore-all lint/style/noExcessiveLinesPerFile: The three Conclave controls share one validation and delivery fence.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Fail-closed supervision validation is intentionally explicit.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Delivery keeps the uncertainty fence auditable.
// biome-ignore-all lint/complexity/useMaxParams: Tool boundaries retain explicit Archive identity fields.
// biome-ignore-all lint/performance/noAwaitInLoops: Bounded session polling preserves the persistence fence.
// biome-ignore-all lint/style/noTernary: Optional Archive fields and bounded mode selection stay explicit.
// biome-ignore-all lint/complexity/noVoid: Validation-only calls intentionally use their thrown errors.
// biome-ignore-all lint/suspicious/useAwait: Tool handlers return the Pi tool promise contract.
// biome-ignore-all lint/style/useDestructuring: Runtime capability reads remain visibly defensive.
// biome-ignore-all lint/style/useBlockStatements: Defensive parsing keeps fail-closed guards compact.
// biome-ignore-all lint/complexity/useLiteralKeys: Untrusted dynamic session data uses explicit keys.
// biome-ignore-all lint/security/noSecrets: Stable persisted Pi entry identifiers are not credentials.
// biome-ignore-all lint/style/useErrorCause: The bounded delivery message remains the actionable error.
// biome-ignore-all lint/style/noNegationElse: Explicit failure branches preserve the delivery evidence path.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getHeadlessRuntime, type HeadlessExecutorRuntime } from "./executor-rpc.js";
import { appendArchiveRecord, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	isUserPriorityApplied,
	listCoordinationRecords,
	listExecutionRecords,
	listInterventionRecords,
	listSignalRecords,
	listVerdictRecords,
	projectCoordinations,
	readCurrentMission,
	readMandate,
	readUserPriority,
	readUserPriorityEnforcement,
	validateProspectiveCoordinationGraph,
} from "./khala-archive-projections.js";
import { readExecutorRecord } from "./khala-executor-registry.js";
import {
	type CoordinationRecord,
	type ExecutorRecord,
	ExecutorStatus,
	type InterventionFailureCategory,
	type InterventionIssuanceRecord,
	type InterventionMode,
	type InterventionOutcomeRecord,
	isSignal,
	type MissionRecord,
	UserPriorityEnforcementPhase,
	type UserPriorityEnforcementRecord,
	type UserPriorityRecord,
} from "./khala-model.js";
import { KhalaRole, readSessionRole } from "./khala-role.js";
import { deterministicActionId, deterministicAssessmentId } from "./khala-supervision.js";
import { failExecutionAndCloseInterventions } from "./khala-supervision-recovery.js";

const SUPERVISION_ACTION_START_ENTRY = "khala-supervision-action-start";
const SUPERVISION_ACTION_RECOVERY_ENTRY = "khala-supervision-action-recovery";
const SUPERVISION_ACTION_COMPLETE_ENTRY = "khala-supervision-action-complete";
const SUPERVISION_MARKER_PREFIX = "\u0000KHALA_SUPERVISION:";
const MAX_REASON_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_TERM_LENGTH = 500;
const DELIVERY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;
const CONCLAVE_PARTICIPANT_HASH_LENGTH = 16;
const GENERIC_REASON = /^(unknown|n\/a|none|no reason|unspecified|generic|tbd)$/i;
const MUTATION_PATTERN =
	/\b(add|remove|drop|expand|shrink|rewrite|replace|waive|weaken|ignore|change)\b.{0,32}\b(scope|acceptance|criterion|criteria|constraint|deliverable)\b/i;
const MUTATION_AUTHORITY_PATTERN =
	/\b(no\s+longer\s+applies?|disregard|optional|not\s+required|different\s+deliverable|new\s+deliverable|instead\s+of|substitute|redefine)\b/i;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const priorityStopExpectationRegistrations = new WeakMap<object, Set<string>>();
const priorityStopDeliveries = new Map<string, Promise<void>>();

type SteerInput = Static<typeof STEER_PARAMETERS>;
type CoordinateInput = Static<typeof COORDINATE_PARAMETERS>;
type OutcomeInput = Static<typeof OUTCOME_PARAMETERS>;
type ActionTargetInput = Readonly<{
	assessmentId: string;
	actionId: string;
	workId: string;
	missionId: string;
	executionId: string;
}>;
type ActionStart = Readonly<{
	assessmentId: string;
	actionId: string;
	actionKind: string;
	mode: string;
	target: ActionTargetInput;
	source: Readonly<{
		assessmentStartEntryId: string;
		firstSourceEntryId: string;
		lastSourceEntryId: string;
		sourceEntryIds: readonly string[];
		missionRecordId: string;
		executionRecordId: string;
	}>;
}>;

type StopHandoffExpectation = Readonly<{
	projectPath: string;
	projectTrusted: boolean;
	workId: string;
	missionId: string;
	executionId: string;
	participantId: string;
	interventionId: string;
	issuanceRecordId: string;
	issuanceRecordedAt: string;
	baselineSignalIds: readonly string[];
	settlementObserved: boolean;
	settlementTarget?: number;
	assessmentId?: string;
	onEnforced?: (blockedSignalId: string) => void | Promise<void>;
}>;

type RuntimeControl = Pick<
	HeadlessExecutorRuntime,
	| "sendSteer"
	| "sendStopHandoff"
	| "sendAbort"
	| "waitForSettled"
	| "setStopPending"
	| "restartFromSession"
	| "closeProcess"
	| "getEntries"
> & {
	getStopHandoffSettlementObservation?: () => Readonly<{ target?: number; observed: boolean }>;
	isStopPending?: boolean;
	stopForRecovery?: () => Promise<boolean>;
};

type SupervisionStopEvent = Readonly<{
	executionId: string;
	state: "barrier-set" | "abort-requested" | "agent-settled" | "handoff-delivered" | "failed";
	error?: string;
}>;

type SupervisionToolOptions = Readonly<{
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean;
	getRuntime?: (executionId: string) => RuntimeControl | undefined;
	onStopEvent?: (event: SupervisionStopEvent) => void;
	registerStopHandoffExpectation?: (
		context: ExtensionContext,
		expectation: StopHandoffExpectation,
	) => void | Promise<void>;
	deliveryTimeoutMs?: number;
	pollIntervalMs?: number;
}>;

const STEER_PARAMETERS = Type.Object({
	assessmentId: Type.String(),
	actionId: Type.String(),
	workId: Type.String(),
	missionId: Type.String(),
	executionId: Type.String(),
	mode: Type.Union([Type.Literal("correction"), Type.Literal("stop")]),
	category: Type.Union([
		Type.Literal("scope"),
		Type.Literal("constraint"),
		Type.Literal("acceptance"),
		Type.Literal("plan"),
		Type.Literal("validation"),
		Type.Literal("no-progress"),
		Type.Literal("unsafe-assumption"),
		Type.Literal("budget"),
		Type.Literal("dependency"),
		Type.Literal("other"),
	]),
	missionTerm: Type.String(),
	reason: Type.String(),
	message: Type.String(),
	triggeringExecutorEntryIds: Type.Array(Type.String()),
});

const COORDINATE_PARAMETERS = Type.Object({
	assessmentId: Type.Optional(Type.String()),
	actionId: Type.String(),
	coordinationId: Type.String(),
	phase: Type.Literal("decision"),
	relation: Type.Union([Type.Literal("dependency"), Type.Literal("peer-conflict")]),
	workId: Type.String(),
	missionId: Type.String(),
	executionId: Type.Optional(Type.String()),
	relatedWorkId: Type.String(),
	relatedMissionId: Type.String(),
	// The related side is the selected upstream for dependency decisions. The
	// primary execution remains optional for prelaunch waiting Work.
	relatedExecutionId: Type.String(),
	selectedWorkId: Type.String(),
	selectedMissionId: Type.String(),
	selectedExecutionId: Type.Optional(Type.String()),
	reason: Type.String(),
	remote: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	classification: Type.Optional(
		Type.Object({
			observedFiles: Type.Array(Type.String()),
			observedModules: Type.Array(Type.String()),
			observedApis: Type.Array(Type.String()),
			observedContracts: Type.Array(Type.String()),
		}),
	),
});

const OUTCOME_PARAMETERS = Type.Object({
	assessmentId: Type.String(),
	actionId: Type.String(),
	interventionId: Type.String(),
	workId: Type.String(),
	missionId: Type.String(),
	executionId: Type.String(),
	outcome: Type.Union([
		Type.Literal("resolved"),
		Type.Literal("partially-resolved"),
		Type.Literal("ignored"),
		Type.Literal("escalated"),
	]),
	reason: Type.String(),
	observedEntryIds: Type.Array(Type.String()),
	resultingSignalId: Type.Optional(Type.String()),
	resultingVerdictId: Type.Optional(Type.String()),
	resultingCoordinationId: Type.Optional(Type.String()),
	resultingExecutionId: Type.Optional(Type.String()),
	failedExecutionRecordId: Type.Optional(Type.String()),
});

const DISPOSE_USER_PRIORITY_PARAMETERS = Type.Object({
	priorityId: Type.String(),
	reason: Type.String(),
});

type DisposeUserPriorityInput = Static<typeof DISPOSE_USER_PRIORITY_PARAMETERS>;

const APPLY_USER_PRIORITY_PARAMETERS = Type.Object({
	priorityId: Type.String(),
});
type ApplyUserPriorityInput = Static<typeof APPLY_USER_PRIORITY_PARAMETERS>;

function registerKhalaSupervisionTools(pi: ExtensionAPI, options: SupervisionToolOptions): void {
	pi.registerTool({
		name: "khala_steer_execution",
		label: "Steer Khala Execution",
		description:
			"Send one bounded Mission-grounded correction or mandatory stop to a current Executor. Action kind: correction=steer; stop=stop.",
		promptSnippet: "Steer one current Khala Executor with a bounded Mission-grounded action",
		executionMode: "sequential",
		parameters: STEER_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return steerExecution(params, context, options);
		},
	});
	pi.registerTool({
		name: "khala_coordinate_work",
		label: "Coordinate Khala Work",
		description:
			"Record one Conclave autonomous dependency or peer-conflict decision. Action kind: decision=coordinate.",
		promptSnippet: "Record a structured Conclave Work coordination decision",
		executionMode: "sequential",
		parameters: COORDINATE_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordCoordination(params, context, options);
		},
	});
	pi.registerTool({
		name: "khala_record_intervention_outcome",
		label: "Record Khala Intervention Outcome",
		description:
			"Close one issued Khala Intervention with bounded observed evidence. Action kind: outcome=intervention-outcome.",
		promptSnippet: "Close one Khala Intervention with observed Executor evidence",
		executionMode: "sequential",
		parameters: OUTCOME_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordInterventionOutcome(params, context, options);
		},
	});
	pi.registerTool({
		name: "khala_dispose_user_priority",
		label: "Dispose stale Khala User Priority",
		description:
			"Record the ignored disposition of a pending User Priority whose peer-conflict Coordination no longer matches.",
		promptSnippet: "Dispose a stale pending User Priority",
		executionMode: "sequential",
		parameters: DISPOSE_USER_PRIORITY_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return Promise.resolve().then(() => disposeUserPriority(params, context, options));
		},
	});
	pi.registerTool({
		name: "khala_apply_user_priority",
		label: "Apply Khala User Priority",
		description:
			"Append the Coordination override for a pending User Priority that still matches its recorded active peer-conflict Coordination.",
		promptSnippet: "Apply a pending User Priority as a Coordination override",
		executionMode: "sequential",
		parameters: APPLY_USER_PRIORITY_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return Promise.resolve().then(() => applyUserPriority(params, context, options));
		},
	});
}

function steerExecution(params: SteerInput, context: ExtensionContext, options: SupervisionToolOptions) {
	return steerExecutionInternal(params, context, options, false);
}

// Shared mandatory-stop protocol: barrier, abort, settlement, baseline, and one
// single-use handoff. The stop-handoff expectation enforces exactly one current
// blocked Signal after settlement.
async function deliverMandatoryStop(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	control: RuntimeControl,
	marker: string,
	targetMessage: string,
	executionId: string,
	onBaselineSignalIds?: (signalIds: readonly string[]) => void | Promise<void>,
): Promise<Readonly<{ persistedEntryIds: readonly string[]; baselineSignalIds: readonly string[] }>> {
	control.setStopPending();
	emitStopEvent(options, executionId, "barrier-set");
	emitStopEvent(options, executionId, "abort-requested");
	await control.sendAbort();
	await control.waitForSettled(options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS);
	emitStopEvent(options, executionId, "agent-settled");
	const baselineSignalIds = listSignalRecords(context.cwd, isProjectTrusted(context)).map((signal) => signal.signalId);
	await onBaselineSignalIds?.(baselineSignalIds);
	const persistedEntryIds = await deliverStopHandoff(control, marker, targetMessage, options);
	emitStopEvent(options, executionId, "handoff-delivered");
	return { persistedEntryIds, baselineSignalIds };
}

async function registerStopExpectation(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	params: Readonly<{ workId: string; missionId: string; executionId: string; assessmentId: string }>,
	target: ReturnType<typeof validateMissionExecution>,
	issuance: InterventionIssuanceRecord,
	archiveRecord: { recordId: string; recordedAt: string },
	control: RuntimeControl,
	baselineSignalIds: readonly string[],
	onEnforced?: (blockedSignalId: string) => void | Promise<void>,
): Promise<void> {
	const settlement = control.getStopHandoffSettlementObservation?.() ?? { observed: false };
	await options.registerStopHandoffExpectation?.(context, {
		projectPath: context.cwd,
		projectTrusted: isProjectTrusted(context),
		workId: params.workId,
		missionId: params.missionId,
		executionId: params.executionId,
		participantId: target.executorParticipantId,
		interventionId: issuance.interventionId,
		issuanceRecordId: archiveRecord.recordId,
		assessmentId: params.assessmentId,
		issuanceRecordedAt: archiveRecord.recordedAt,
		baselineSignalIds,
		settlementObserved: settlement.observed,
		...(settlement.target === undefined ? {} : { settlementTarget: settlement.target }),
		...(onEnforced === undefined ? {} : { onEnforced }),
	});
}

async function steerExecutionInternal(
	params: SteerInput,
	context: ExtensionContext,
	options: SupervisionToolOptions,
	allowCoordinationTarget: boolean,
) {
	assertConclave(context, options);
	assertActionRecordKind(context, params.actionId, "intervention");
	const existing = readInterventionByAction(context.cwd, params.actionId, isProjectTrusted(context));
	if (existing !== undefined) {
		if (existing.payload.phase === "issuance" && sameSteerReplay(existing.payload, params)) {
			const archiveRecord = listArchiveRecords(context.cwd, isProjectTrusted(context)).find(
				(record) =>
					record.type === "intervention" &&
					typeof record.payload === "object" &&
					record.payload !== null &&
					(record.payload as { actionId?: unknown }).actionId === params.actionId &&
					(record.payload as { phase?: unknown }).phase === "issuance" &&
					(record.payload as { interventionId?: unknown }).interventionId === existing.payload.interventionId,
			);
			const actionStart = findActionStart(context, params.actionId);
			if (archiveRecord !== undefined && actionStart !== undefined) {
				appendActionComplete(context, actionStart, archiveRecord.recordId);
			}
			return toolResult(
				`Intervention ${existing.payload.interventionId} already exists; replay reused.`,
				existing.payload,
			);
		}
		throw new Error(`Intervention action ${params.actionId} has conflicting evidence.`);
	}
	validateAssessmentTarget(
		params,
		context,
		options,
		params.mode === "stop" ? "stop" : "steer",
		allowCoordinationTarget,
	);
	const target = validateMissionExecution(context, params.workId, params.missionId, params.executionId);
	validateTriggeringEntries(params, context);
	validateSteerText(params, target.mission);
	const actionStart = reserveActionStart(context, params, params.mode === "stop" ? "stop" : "steer", target);
	const control = (options.getRuntime ?? getHeadlessRuntime)(params.executionId);
	if (control === undefined) {
		throw new Error(`Execution ${params.executionId} has no live headless Pi RPC runtime.`);
	}
	const marker = supervisionMarker(params.actionId, params.mode);
	const targetMessage =
		params.mode === "stop" ? mandatoryStopPrompt(params.reason, params.message) : params.message.trim();
	const persistedBeforeSend = await readMarkedEntriesFromRuntime(control, marker);
	if (persistedBeforeSend.length > 0) {
		return finalizeSteerIssuance(
			context,
			options,
			params,
			target,
			actionStart,
			persistedBeforeSend,
			targetMessage,
			params.mode === "stop" ? "abort-settled-prompt-acknowledged" : "steer-acknowledged",
			control,
			[],
			allowCoordinationTarget,
		);
	}
	validateReservedTarget(context, params, target, actionStart, allowCoordinationTarget);
	const outstanding = listInterventionProjections(context.cwd, isProjectTrusted(context)).find(
		(item) =>
			item.outstanding &&
			item.issuance.executionId === params.executionId &&
			item.issuance.category === params.category &&
			item.issuance.missionTerm === params.missionTerm.trim(),
	);
	if (outstanding !== undefined) {
		throw new Error(`Execution ${params.executionId} has an outstanding Intervention for this concern.`);
	}
	let persistedEntryIds: readonly string[];
	let transport: "steer-acknowledged" | "abort-settled-prompt-acknowledged";
	let baselineSignalIds: readonly string[] = [];
	try {
		if (params.mode === "correction") {
			persistedEntryIds = await deliverCorrection(context, control, marker, actionStart, targetMessage, options);
			transport = "steer-acknowledged";
		} else {
			const delivered = await deliverMandatoryStop(
				context,
				options,
				control,
				marker,
				targetMessage,
				params.executionId,
			);
			baselineSignalIds = delivered.baselineSignalIds;
			persistedEntryIds = delivered.persistedEntryIds;
			transport = "abort-settled-prompt-acknowledged";
		}
	} catch (error) {
		if (params.mode === "stop") {
			emitStopEvent(options, params.executionId, "failed", errorMessage(error));
		}
		await failRuntime(context, params.executionId, control);
		throw new Error(
			`Intervention delivery failed; Execution ${params.executionId} was marked failed: ${errorMessage(error)}`,
		);
	}
	return finalizeSteerIssuance(
		context,
		options,
		params,
		target,
		actionStart,
		persistedEntryIds,
		targetMessage,
		transport,
		control,
		baselineSignalIds,
		allowCoordinationTarget,
	);
}

async function recordCoordination(params: CoordinateInput, context: ExtensionContext, options: SupervisionToolOptions) {
	assertConclave(context, options);
	const projectTrusted = isProjectTrusted(context);
	assertActionRecordKind(context, params.actionId, "coordination");
	if (params.assessmentId !== undefined) {
		validateAssessmentTarget(params as ActionTargetInput, context, options, "coordinate");
	}
	const target =
		params.executionId === undefined
			? undefined
			: validateMissionExecution(context, params.workId, params.missionId, params.executionId);
	if (params.relation === "dependency" && params.relatedExecutionId === undefined) {
		throw new Error("A dependency Coordination requires the selected upstream Execution.");
	}
	const relatedMission = currentMission(context.cwd, params.relatedWorkId, params.relatedMissionId, projectTrusted);
	const relatedExecution =
		params.relatedExecutionId === undefined
			? undefined
			: currentExecution(
					context.cwd,
					params.relatedWorkId,
					params.relatedMissionId,
					params.relatedExecutionId,
					projectTrusted,
				);
	if (
		relatedExecution !== undefined &&
		relatedExecution.participantId !== relatedMission.mission.assignedParticipantId
	) {
		throw new Error("Related Execution is not the assigned Mission Executor.");
	}
	if (params.workId === params.relatedWorkId && params.missionId === params.relatedMissionId) {
		throw new Error("Coordination requires two distinct Work/Mission identities.");
	}
	const reason = boundedReason(params.reason, "Coordination reason");
	if (params.relation === "dependency") {
		if (params.remote?.trim().length === 0 || params.branch?.trim().length === 0) {
			throw new Error("A dependency Coordination requires the exact remote and branch.");
		}
		if (
			params.relatedWorkId !== params.selectedWorkId ||
			params.relatedMissionId !== params.selectedMissionId ||
			params.relatedExecutionId !== params.selectedExecutionId
		) {
			throw new Error("Dependency Coordination must select the identified upstream side.");
		}
	}
	if (params.selectedWorkId !== params.workId && params.selectedWorkId !== params.relatedWorkId) {
		throw new Error("Coordination priority must select one of the two identified Work sides.");
	}
	if (
		params.selectedWorkId === params.workId &&
		(params.selectedMissionId !== params.missionId ||
			(params.selectedExecutionId !== undefined && params.selectedExecutionId !== params.executionId))
	) {
		throw new Error("Selected priority identity does not match the primary Work side.");
	}
	if (
		params.selectedWorkId === params.relatedWorkId &&
		(params.selectedMissionId !== params.relatedMissionId ||
			(params.selectedExecutionId !== undefined && params.selectedExecutionId !== params.relatedExecutionId))
	) {
		throw new Error("Selected priority identity does not match the related Work side.");
	}
	const coordination: CoordinationRecord = {
		coordinationId: requireId(params.coordinationId, "coordinationId"),
		actionId: params.actionId,
		phase: params.phase,
		relation: params.relation,
		workId: params.workId,
		missionId: params.missionId,
		selectedWorkId: params.selectedWorkId,
		selectedMissionId: params.selectedMissionId,
		relatedWorkId: params.relatedWorkId,
		relatedMissionId: params.relatedMissionId,
		...(params.executionId === undefined ? {} : { executionId: params.executionId }),
		...(params.relatedExecutionId === undefined ? {} : { relatedExecutionId: params.relatedExecutionId }),
		...(params.selectedExecutionId === undefined ? {} : { selectedExecutionId: params.selectedExecutionId }),
		...(params.relation === "dependency"
			? {
					upstreamWorkId: params.relatedWorkId,
					upstreamMissionId: params.relatedMissionId,
					upstreamExecutionId: params.relatedExecutionId,
				}
			: {}),
		reason,
		...(params.remote === undefined ? {} : { remote: params.remote.trim() }),
		...(params.branch === undefined ? {} : { branch: params.branch.trim() }),
		...(params.classification === undefined ? {} : { classification: params.classification }),
	};
	const actionStart =
		target === undefined || params.assessmentId === undefined
			? undefined
			: reserveActionStart(
					context,
					params as ActionTargetInput,
					params.phase === "decision" ? "coordinate" : "coordinate-override",
					target,
				);
	const archiveRecord = withArchiveLock(context.cwd, projectTrusted, () => {
		const lockedExisting = readCoordinationByAction(context.cwd, params.actionId, projectTrusted);
		if (lockedExisting !== undefined) {
			if (sameCoordinationReplay(lockedExisting.payload, params)) {
				const existingRecord = listArchiveRecords(context.cwd, projectTrusted).find(
					(record) =>
						record.type === "coordination" &&
						typeof record.payload === "object" &&
						record.payload !== null &&
						(record.payload as { actionId?: unknown }).actionId === params.actionId,
				);
				if (existingRecord === undefined) throw new Error("Coordination replay evidence disappeared.");
				return existingRecord;
			}
			throw new Error(`Coordination action ${params.actionId} has conflicting evidence.`);
		}
		const primaryMission = currentMission(context.cwd, params.workId, params.missionId, projectTrusted);
		const lockedRelatedMission = currentMission(
			context.cwd,
			params.relatedWorkId,
			params.relatedMissionId,
			projectTrusted,
		);
		if (primaryMission.state !== "current") throw new Error("Coordination requires a current primary Mission.");
		if (lockedRelatedMission.state !== "current") throw new Error("Coordination requires a current related Mission.");
		if (params.relatedExecutionId !== undefined) {
			const lockedRelatedExecution = currentExecution(
				context.cwd,
				params.relatedWorkId,
				params.relatedMissionId,
				params.relatedExecutionId,
				projectTrusted,
			);
			if (lockedRelatedExecution.participantId !== lockedRelatedMission.mission.assignedParticipantId) {
				throw new Error("Related Execution is not the assigned current Mission Executor.");
			}
		}
		if (target !== undefined) {
			const lockedTarget = validateMissionExecution(
				context,
				params.workId,
				params.missionId,
				params.executionId as string,
			);
			if (
				lockedTarget.mission.missionId !== primaryMission.mission.missionId ||
				lockedTarget.execution.workId !== params.workId
			) {
				throw new Error("Coordination primary Execution does not match the current primary Mission.");
			}
		}
		validateProspectiveCoordinationGraph(listCoordinationRecords(context.cwd, projectTrusted), coordination);
		return coordination.executionId === undefined
			? appendArchiveRecord(
					context.cwd,
					{ schemaVersion: 2, type: "coordination", workId: coordination.workId, payload: coordination },
					projectTrusted,
				)
			: appendArchiveRecord(
					context.cwd,
					{
						schemaVersion: 2,
						type: "coordination",
						workId: coordination.workId,
						executionId: coordination.executionId,
						payload: coordination,
					},
					projectTrusted,
				);
	});
	if (
		params.assessmentId !== undefined &&
		(params.executionId !== undefined || params.relatedExecutionId !== undefined)
	) {
		await stopLowerPriorityPrimary(context, options, params);
	}
	if (actionStart !== undefined) {
		appendActionComplete(context, actionStart, archiveRecord.recordId);
	}
	return toolResult(`Coordination ${coordination.coordinationId} recorded.`, archiveRecord.payload);
}

async function stopLowerPriorityPrimary(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	params: CoordinateInput,
): Promise<void> {
	if (params.assessmentId === undefined) {
		return;
	}
	let workId = params.workId;
	let missionId = params.missionId;
	let executionId = params.executionId;
	if (params.selectedWorkId === params.workId) {
		workId = params.relatedWorkId;
		missionId = params.relatedMissionId;
		executionId = params.relatedExecutionId;
	}
	if (executionId === undefined) {
		return;
	}
	const control = (options.getRuntime ?? getHeadlessRuntime)(executionId);
	if (control === undefined) {
		const execution = readExecutorRecord(context.cwd, executionId, isProjectTrusted(context));
		if (execution?.status === ExecutorStatus.starting || execution?.status === ExecutorStatus.running) {
			await failExecutionAndCloseInterventions(context.cwd, executionId, isProjectTrusted(context));
		}
		return;
	}
	const assessment = context.sessionManager
		.getEntries()
		.find(
			(entry): entry is AssessmentEntry => isAssessmentEntry(entry) && entry.data.assessmentId === params.assessmentId,
		);
	if (assessment === undefined) {
		throw new Error("A live Coordination stop requires its current assessment source range.");
	}
	const lowerMission = currentMission(context.cwd, workId, missionId, isProjectTrusted(context));
	const stop: SteerInput = {
		assessmentId: params.assessmentId,
		actionId: deterministicActionId(params.assessmentId, "stop"),
		workId,
		missionId,
		executionId,
		mode: "stop",
		category: "dependency",
		missionTerm: lowerMission.mission.assignment.scope,
		reason: params.reason,
		message: "Stop this lower-priority attempt and submit the required blocked Signal before any further changes.",
		triggeringExecutorEntryIds: [...assessment.data.sourceEntryIds],
	};
	await steerExecutionInternal(stop, context, { ...options, getRuntime: () => control }, true);
}

async function recordInterventionOutcome(
	params: OutcomeInput,
	context: ExtensionContext,
	options: SupervisionToolOptions,
) {
	assertConclave(context, options);
	const projectTrusted = isProjectTrusted(context);
	assertActionRecordKind(context, params.actionId, "intervention");
	const existingOutcome = listInterventionRecords(context.cwd, projectTrusted).find(
		(record): record is InterventionOutcomeRecord =>
			record.phase === "outcome" &&
			record.actionId === params.actionId &&
			record.interventionId === params.interventionId,
	);
	if (existingOutcome !== undefined) {
		if (sameOutcomeReplay(existingOutcome, params)) {
			return toolResult(`Intervention ${params.interventionId} outcome replay reused.`, existingOutcome);
		}
		throw new Error(`Intervention outcome action ${params.actionId} has conflicting evidence.`);
	}
	validateAssessmentTarget(params, context, options, "intervention-outcome");
	const issuance = readInterventionIssuance(context.cwd, params.interventionId, projectTrusted);
	if (issuance === undefined) {
		throw new Error(`Intervention ${params.interventionId} has no durable issuance.`);
	}
	if (
		issuance.workId !== params.workId ||
		issuance.missionId !== params.missionId ||
		issuance.executionId !== params.executionId
	) {
		throw new Error("Intervention outcome target does not match its issuance identity.");
	}
	const priorOutcome = listInterventionRecords(context.cwd, projectTrusted).find(
		(record): record is InterventionOutcomeRecord =>
			record.phase === "outcome" && record.interventionId === params.interventionId,
	);
	if (priorOutcome !== undefined) {
		if (priorOutcome.actionId === params.actionId) {
			return toolResult(`Intervention ${params.interventionId} outcome replay reused.`, priorOutcome);
		}
		throw new Error(`Intervention ${params.interventionId} already has a conflicting outcome.`);
	}
	const target = readExecutorRecord(context.cwd, params.executionId, projectTrusted);
	if (
		target === undefined ||
		target.workId !== params.workId ||
		target.missionId !== params.missionId ||
		target.piSessionId !== issuance.piSessionId
	) {
		throw new Error("Intervention outcome target is not the current Execution record.");
	}
	currentMission(context.cwd, params.workId, params.missionId, projectTrusted);
	const reason = boundedReason(params.reason, "Intervention outcome reason");
	const failedRecord = params.failedExecutionRecordId;
	if (failedRecord === undefined) {
		if (params.observedEntryIds.length === 0) {
			throw new Error("An Intervention outcome requires observed target Pi entry IDs.");
		}
		validateObservedEntries(target, params.observedEntryIds, issuance.piEntryIds);
	} else {
		if (params.outcome !== "escalated" || params.observedEntryIds.length > 0) {
			throw new Error("Only an escalated runtime-loss outcome may use failed Execution evidence, without Pi entries.");
		}
		const executionRecords = listArchiveRecords(context.cwd, projectTrusted).filter(
			(record) =>
				record.type === "execution" && record.executionId === params.executionId && record.workId === params.workId,
		);
		const latestExecutionRecord = executionRecords.at(-1);
		const latestProjection = readExecutorRecord(target.projectPath, params.executionId, projectTrusted);
		if (
			latestExecutionRecord === undefined ||
			latestExecutionRecord.recordId !== failedRecord ||
			latestProjection?.status !== ExecutorStatus.failed ||
			latestExecutionRecord.payload === undefined ||
			typeof latestExecutionRecord.payload !== "object" ||
			(latestExecutionRecord.payload as { status?: unknown }).status !== ExecutorStatus.failed
		) {
			throw new Error("failedExecutionRecordId must be the latest exact failed Execution transition.");
		}
	}
	const reservationTarget = readArchiveBindings(context, params.workId, params.missionId, params.executionId);
	const actionStart = reserveActionStart(context, params, "intervention-outcome", reservationTarget);
	validateResultingReferences(context.cwd, projectTrusted, params, target, issuance.conclaveParticipantId);
	const outcome: InterventionOutcomeRecord = {
		...issuance,
		phase: "outcome",
		actionId: params.actionId,
		outcome: params.outcome,
		observedEntryIds: params.observedEntryIds,
		reason,
		...(params.resultingSignalId === undefined ? {} : { resultingSignalId: params.resultingSignalId }),
		...(params.resultingVerdictId === undefined ? {} : { resultingVerdictId: params.resultingVerdictId }),
		...(params.resultingCoordinationId === undefined
			? {}
			: { resultingCoordinationId: params.resultingCoordinationId }),
		...(params.resultingExecutionId === undefined ? {} : { resultingExecutionId: params.resultingExecutionId }),
		...(failedRecord === undefined ? {} : { failedExecutionRecordId: failedRecord }),
	};
	const archiveRecord = appendArchiveRecord(
		context.cwd,
		{
			schemaVersion: 2,
			type: "intervention",
			workId: outcome.workId,
			executionId: outcome.executionId,
			payload: outcome,
		},
		projectTrusted,
	);
	appendActionComplete(context, actionStart, archiveRecord.recordId);
	return toolResult(`Intervention ${params.interventionId} closed as ${params.outcome}.`, outcome);
}

function assertConclave(context: ExtensionContext, options: SupervisionToolOptions): void {
	if (!options.isDedicatedConclaveSession(context) || readSessionRole(context) !== KhalaRole.conclave) {
		throw new Error("Only the dedicated project Conclave may use supervision controls.");
	}
	if (context.sessionManager.getSessionFile() === undefined) {
		throw new Error("Conclave supervision requires a persisted Pi session.");
	}
}

function validateAssessmentTarget(
	params: { assessmentId: string; actionId: string; workId: string; missionId: string; executionId: string },
	context: ExtensionContext,
	options: SupervisionToolOptions,
	actionKind: string,
	allowCoordinationTarget = false,
): RuntimeControl | undefined {
	requireId(params.assessmentId, "assessmentId");
	requireId(params.actionId, "actionId");
	const entries = context.sessionManager.getEntries();
	const start = entries.find(
		(entry): entry is AssessmentEntry => isAssessmentEntry(entry) && entry.data.assessmentId === params.assessmentId,
	);
	if (start === undefined) {
		throw new Error(`Assessment ${params.assessmentId} is not present in the current Conclave session.`);
	}
	const complete = entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "khala-supervision-assessment-complete" &&
			isAssessmentStartData(entry.data) &&
			entry.data.assessmentId === params.assessmentId,
	);
	if (complete) {
		throw new Error(`Assessment ${params.assessmentId} is stale because it is already complete.`);
	}
	if (
		!allowCoordinationTarget &&
		(start.data.workId !== params.workId ||
			start.data.missionId !== params.missionId ||
			start.data.executionId !== params.executionId)
	) {
		throw new Error("Supervision action crosses the assessment Work, Mission, or Execution boundary.");
	}
	let assessmentExecutionId = params.executionId;
	if (allowCoordinationTarget) {
		assessmentExecutionId = start.data.executionId;
	}
	const expectedAssessment = deterministicAssessmentId(
		assessmentExecutionId,
		start.data.firstSourceEntryId,
		start.data.lastSourceEntryId,
	);
	if (params.assessmentId !== expectedAssessment) {
		throw new Error("Assessment ID does not match its persisted source range.");
	}
	const expectedIds = new Set([
		deterministicActionId(params.assessmentId, actionKind),
		deterministicActionId(params.assessmentId, actionKind, 0),
	]);
	if (!expectedIds.has(params.actionId)) {
		throw new Error(
			`Action ${params.actionId} does not match the deterministic ${actionKind} action for this assessment.`,
		);
	}
	return (options.getRuntime ?? getHeadlessRuntime)(params.executionId);
}

function reserveActionStart(
	context: ExtensionContext,
	params: ActionTargetInput,
	actionKind: string,
	target: Readonly<{ missionRecordId: string; executionRecordId: string }>,
): ActionStart {
	const assessment = context.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "khala-supervision-assessment-start" &&
				isAssessmentStartData(entry.data) &&
				entry.data.assessmentId === params.assessmentId,
		);
	if (assessment === undefined || assessment.type !== "custom" || !isAssessmentStartData(assessment.data)) {
		throw new Error(`Assessment ${params.assessmentId} has no persisted source range for action reservation.`);
	}
	const data: ActionStart = {
		assessmentId: params.assessmentId,
		actionId: params.actionId,
		actionKind,
		mode: actionKind,
		target: {
			assessmentId: params.assessmentId,
			actionId: params.actionId,
			workId: params.workId,
			missionId: params.missionId,
			executionId: params.executionId,
		},
		source: {
			assessmentStartEntryId: assessment.id,
			firstSourceEntryId: assessment.data.firstSourceEntryId,
			lastSourceEntryId: assessment.data.lastSourceEntryId,
			sourceEntryIds: assessment.data.sourceEntryIds,
			missionRecordId: target.missionRecordId,
			executionRecordId: target.executionRecordId,
		},
	};
	const existing = context.sessionManager
		.getEntries()
		.find(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === SUPERVISION_ACTION_START_ENTRY &&
				isActionStart(entry.data) &&
				entry.data.actionId === params.actionId,
		);
	if (existing !== undefined && (existing.type !== "custom" || !isActionStart(existing.data))) {
		throw new Error(`Supervision action ${params.actionId} has invalid reservation evidence.`);
	}
	if (existing !== undefined && JSON.stringify(existing.data) !== JSON.stringify(data)) {
		throw new Error(`Supervision action ${params.actionId} has conflicting reservation evidence.`);
	}
	if (existing === undefined) {
		appendSessionCustomEntry(context, SUPERVISION_ACTION_START_ENTRY, data);
	}
	return data;
}

function validateReservedTarget(
	context: ExtensionContext,
	params: ActionTargetInput,
	reservationTarget: ReturnType<typeof validateMissionExecution>,
	actionStart: ActionStart,
	allowCoordinationTarget = false,
): void {
	const records = listArchiveRecords(context.cwd, isProjectTrusted(context));
	const sourceMission = records.find((record) => record.recordId === actionStart.source.missionRecordId);
	const sourceExecution = records.find((record) => record.recordId === actionStart.source.executionRecordId);
	const sourceMissionId =
		sourceMission?.type === "mission" && typeof sourceMission.payload === "object" && sourceMission.payload !== null
			? (sourceMission.payload as { missionId?: unknown }).missionId
			: undefined;
	const sourceExecutionMissionId =
		sourceExecution?.type === "execution" &&
		typeof sourceExecution.payload === "object" &&
		sourceExecution.payload !== null
			? (sourceExecution.payload as { missionId?: unknown }).missionId
			: undefined;
	if (
		sourceMission?.type !== "mission" ||
		sourceExecution?.type !== "execution" ||
		(!allowCoordinationTarget &&
			(sourceMission.workId !== params.workId ||
				sourceMissionId !== params.missionId ||
				sourceExecution.workId !== params.workId ||
				sourceExecution.executionId !== params.executionId ||
				sourceExecutionMissionId !== params.missionId))
	) {
		throw new Error("Supervision action reservation evidence is unavailable or crosses its target boundary.");
	}
	const current = validateMissionExecution(context, params.workId, params.missionId, params.executionId);
	if (!sameImmutableExecutionBindings(current.execution, reservationTarget.execution)) {
		throw new Error("Supervision target changed its immutable Execution bindings after action reservation.");
	}
}

function sameImmutableExecutionBindings(left: ExecutorRecord, right: ExecutorRecord): boolean {
	return (
		JSON.stringify({
			workId: left.workId,
			missionId: left.missionId,
			kind: left.kind,
			participantId: left.participantId,
			purpose: left.purpose,
			projectPath: resolve(left.projectPath),
			piSessionId: left.piSessionId,
			sessionPath: left.sessionPath,
			promptIdentity: left.promptIdentity,
			upstreamBase: left.upstreamBase,
		}) ===
		JSON.stringify({
			workId: right.workId,
			missionId: right.missionId,
			kind: right.kind,
			participantId: right.participantId,
			purpose: right.purpose,
			projectPath: resolve(right.projectPath),
			piSessionId: right.piSessionId,
			sessionPath: right.sessionPath,
			promptIdentity: right.promptIdentity,
			upstreamBase: right.upstreamBase,
		})
	);
}

async function finalizeSteerIssuance(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	params: SteerInput,
	target: ReturnType<typeof validateMissionExecution>,
	actionStart: ActionStart,
	piEntryIds: readonly string[],
	archiveMessage: string,
	transport: "steer-acknowledged" | "abort-settled-prompt-acknowledged",
	control: RuntimeControl,
	baselineSignalIds: readonly string[],
	allowCoordinationTarget = false,
) {
	validateReservedTarget(context, params, target, actionStart, allowCoordinationTarget);
	const issuance = createIssuance(context.cwd, params, target, piEntryIds, archiveMessage);
	const archiveRecord = appendArchiveRecord(
		context.cwd,
		{
			schemaVersion: 2,
			type: "intervention",
			workId: issuance.workId,
			executionId: issuance.executionId,
			payload: issuance,
		},
		isProjectTrusted(context),
	);
	appendActionComplete(context, actionStart, archiveRecord.recordId);
	if (params.mode === "stop") {
		await registerStopExpectation(
			context,
			options,
			params,
			target,
			issuance,
			archiveRecord,
			control,
			baselineSignalIds,
		);
	}
	return toolResult(
		`Intervention ${issuance.interventionId} delivered to persisted Pi entries ${piEntryIds.join(", ")}.`,
		{ ...issuance, delivery: { rpc: transport, persisted: true, entryIds: piEntryIds } },
	);
}

function appendActionComplete(context: ExtensionContext, actionStart: ActionStart, archiveRecordId: string): void {
	const exists = context.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === SUPERVISION_ACTION_COMPLETE_ENTRY &&
				isActionComplete(entry.data) &&
				entry.data.actionId === actionStart.actionId,
		);
	if (!exists) {
		appendSessionCustomEntry(context, SUPERVISION_ACTION_COMPLETE_ENTRY, {
			actionId: actionStart.actionId,
			assessmentId: actionStart.assessmentId,
			archiveRecordId,
		});
	}
}

function assertActionRecordKind(
	context: ExtensionContext,
	actionId: string,
	expected: "coordination" | "intervention",
): void {
	for (const record of listArchiveRecords(context.cwd, isProjectTrusted(context))) {
		if (
			(record.type === "coordination" || record.type === "intervention") &&
			typeof record.payload === "object" &&
			record.payload !== null &&
			"actionId" in record.payload &&
			(record.payload as { actionId?: unknown }).actionId === actionId &&
			record.type !== expected
		) {
			throw new Error(`Supervision action ${actionId} is already bound to ${record.type}, not ${expected}.`);
		}
	}
}

function validateMissionExecution(
	context: ExtensionContext,
	workId: string,
	missionId: string,
	executionId: string,
): {
	mission: MissionRecord;
	execution: ExecutorRecord;
	mandateId: string;
	executorParticipantId: string;
	missionRecordId: string;
	executionRecordId: string;
} {
	const projectTrusted = isProjectTrusted(context);
	const current = currentMission(context.cwd, workId, missionId, projectTrusted);
	const execution = currentExecution(context.cwd, workId, missionId, executionId, projectTrusted);
	if (
		execution.status !== ExecutorStatus.running ||
		execution.kind !== "executor" ||
		execution.sessionPath === undefined ||
		execution.piSessionId === undefined ||
		execution.promptIdentity === undefined
	) {
		throw new Error("Supervision target is not a current running Executor with a persisted Pi session binding.");
	}
	if (
		execution.participantId === undefined ||
		execution.purpose?.kind !== "mission" ||
		execution.participantId !== current.mission.assignedParticipantId
	) {
		throw new Error("Supervision target lacks the assigned Mission Executor participant identity.");
	}
	const mandate = readMandate(context.cwd, current.mission.mandateId, projectTrusted);
	if (mandate === undefined || mandate.workId !== workId) {
		throw new Error("Supervision target governing Mandate is unavailable.");
	}
	const archiveRecords = listArchiveRecords(context.cwd, projectTrusted);
	const missionRecord = [...archiveRecords]
		.reverse()
		.find(
			(record) =>
				record.type === "mission" &&
				record.workId === workId &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { missionId?: unknown }).missionId === missionId,
		);
	const executionRecord = [...archiveRecords]
		.reverse()
		.find((record) => record.type === "execution" && record.executionId === executionId && record.workId === workId);
	if (missionRecord === undefined || executionRecord === undefined) {
		throw new Error("Supervision target Archive bindings are unavailable.");
	}
	return {
		mission: current.mission,
		execution,
		mandateId: mandate.mandateId,
		executorParticipantId: execution.participantId,
		missionRecordId: missionRecord.recordId,
		executionRecordId: executionRecord.recordId,
	};
}

function currentMission(
	projectPath: string,
	workId: string,
	missionId: string,
	projectTrusted: boolean,
): { mission: MissionRecord; state: string } {
	const current = readCurrentMission(projectPath, workId, projectTrusted);
	if (current === undefined || current.state !== "current" || current.mission.missionId !== missionId) {
		throw new Error("Supervision target references a stale or non-current Mission.");
	}
	return current;
}

function currentExecution(
	projectPath: string,
	workId: string,
	missionId: string,
	executionId: string,
	projectTrusted: boolean,
): ExecutorRecord {
	const execution = readExecutorRecord(projectPath, executionId, projectTrusted);
	if (
		execution === undefined ||
		execution.workId !== workId ||
		execution.missionId !== missionId ||
		resolve(execution.projectPath) !== resolve(projectPath)
	) {
		throw new Error("Supervision target references an unknown or cross-boundary Execution.");
	}
	return execution;
}

function validateTriggeringEntries(params: SteerInput, context: ExtensionContext): void {
	const start = context.sessionManager
		.getEntries()
		.find(
			(entry): entry is AssessmentEntry => isAssessmentEntry(entry) && entry.data.assessmentId === params.assessmentId,
		);
	if (start === undefined || params.triggeringExecutorEntryIds.length === 0) {
		throw new Error("A steer requires triggering Executor entry IDs from the current assessment.");
	}
	const sourceIds = new Set(start.data.sourceEntryIds);
	if (new Set(params.triggeringExecutorEntryIds).size !== params.triggeringExecutorEntryIds.length) {
		throw new Error("Steer triggering Executor entry IDs must be unique.");
	}
	if (params.triggeringExecutorEntryIds.some((id) => !sourceIds.has(id))) {
		throw new Error("Steer triggering Executor entry IDs cross the persisted assessment source range.");
	}
}

function validateSteerText(params: SteerInput, mission: MissionRecord): void {
	if (params.mode === "stop" && !["dependency", "unsafe-assumption", "constraint"].includes(params.category)) {
		throw new Error("Stop mode is permitted only for dependency, unsafe-assumption, or constraint failures.");
	}
	const term = bounded(params.missionTerm, "Mission term");
	const reason = boundedReason(params.reason, "Intervention reason");
	const message = bounded(params.message, "Intervention message");
	const terms = canonicalMissionTerms(mission);
	if (!terms.has(term)) {
		throw new Error("missionTerm must exactly equal an implicated canonical Mission term.");
	}
	if (
		(params.category === "scope" && term !== mission.assignment.scope) ||
		(params.category === "acceptance" && !mission.assignment.acceptanceCriteria.includes(term)) ||
		(params.category === "constraint" && !mission.assignment.constraints.includes(term))
	) {
		throw new Error("The failure category does not match the exact canonical Mission term.");
	}
	if (MUTATION_PATTERN.test(`${reason}\n${message}`) || MUTATION_AUTHORITY_PATTERN.test(`${reason}\n${message}`)) {
		throw new Error("Steering cannot mutate Mission scope, acceptance, constraints, or deliverables.");
	}
}

function canonicalMissionTerms(mission: MissionRecord): Set<string> {
	return new Set(
		[
			mission.assignment.objective,
			mission.assignment.context,
			mission.assignment.scope,
			...mission.assignment.acceptanceCriteria,
			...mission.assignment.constraints,
			...mission.assignment.plan,
			...mission.assignment.validation,
		].filter((term) => term.trim().length > 0),
	);
}

async function deliverCorrection(
	context: ExtensionContext,
	control: RuntimeControl,
	marker: string,
	actionStart: ActionStart,
	message: string,
	options: SupervisionToolOptions,
): Promise<readonly string[]> {
	const marked = `${marker}${message}`;
	try {
		await control.sendSteer(marked);
		return await waitForMarkedEntry(control, marker, options);
	} catch (firstError) {
		let alreadyRestarted = false;
		if (control.stopForRecovery === undefined) {
			await control.closeProcess();
		} else {
			alreadyRestarted = (await control.stopForRecovery()) === true;
		}
		const persisted = await readMarkedEntriesFromRuntime(control, marker);
		if (persisted.length > 0) {
			return persisted;
		}
		appendActionRecovery(context, actionStart);
		if (!alreadyRestarted) {
			await control.restartFromSession();
		}
		try {
			await control.sendSteer(marked);
			return await waitForMarkedEntry(control, marker, options);
		} catch (secondError) {
			throw new Error(
				`Uncertain steer delivery could not be recovered (${errorMessage(firstError)}; ${errorMessage(secondError)}).`,
			);
		}
	}
}

async function deliverStopHandoff(
	control: RuntimeControl,
	marker: string,
	reason: string,
	options: SupervisionToolOptions,
): Promise<readonly string[]> {
	const marked = `${marker}${reason}`;
	await control.sendStopHandoff(marked);
	return waitForMarkedEntry(control, marker, options);
}

async function waitForMarkedEntry(
	control: RuntimeControl,
	marker: string,
	options: SupervisionToolOptions,
): Promise<readonly string[]> {
	const deadline = Date.now() + (options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS);
	while (Date.now() < deadline) {
		const entries = await control.getEntries();
		const matched = markedUserEntryIds(entries.entries, marker);
		if (matched.length > 0) {
			return matched;
		}
		await delay(options.pollIntervalMs ?? POLL_INTERVAL_MS);
	}
	throw new Error("The native RPC acknowledgement was not followed by a persisted marked User entry.");
}

function findActionStart(context: ExtensionContext, actionId: string): ActionStart | undefined {
	for (const entry of context.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === SUPERVISION_ACTION_START_ENTRY) {
			const data = (entry as { data?: unknown }).data;
			if (isActionStart(data) && data.actionId === actionId) {
				return data;
			}
		}
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy the non-void union return contract.
	return undefined;
}

function appendSessionCustomEntry(context: ExtensionContext, customType: string, data: unknown): void {
	(
		context.sessionManager as unknown as { appendCustomEntry: (type: string, value: unknown) => string }
	).appendCustomEntry(customType, data);
}

function appendActionRecovery(context: ExtensionContext, actionStart: ActionStart): void {
	const exists = context.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === SUPERVISION_ACTION_RECOVERY_ENTRY &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				(entry.data as { actionId?: unknown }).actionId === actionStart.actionId,
		);
	if (!exists) {
		appendSessionCustomEntry(context, SUPERVISION_ACTION_RECOVERY_ENTRY, {
			actionId: actionStart.actionId,
			assessmentId: actionStart.assessmentId,
			state: "resend",
		});
	}
}

async function readMarkedEntriesFromRuntime(control: RuntimeControl, marker: string): Promise<readonly string[]> {
	try {
		const result = await control.getEntries();
		return markedUserEntryIds(result.entries, marker);
	} catch {
		return readMarkedEntriesFromSession(control, marker);
	}
}

function readMarkedEntriesFromSession(control: RuntimeControl, marker: string): readonly string[] {
	const sessionPath = (control as unknown as { sessionPath?: string }).sessionPath;
	if (typeof sessionPath !== "string" || !existsSync(sessionPath)) {
		return [];
	}
	try {
		const entries: unknown[] = readFileSync(sessionPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		return markedUserEntryIds(entries, marker);
	} catch {
		return [];
	}
}

function markedUserEntryIds(entries: readonly unknown[], marker: string): readonly string[] {
	return entries.flatMap((entry) => {
		if (!isSessionMessageUserEntry(entry)) {
			return [];
		}
		const text = userMessageText(entry.message.content);
		return text.includes(marker) ? [entry.id] : [];
	});
}

function isSessionMessageUserEntry(
	value: unknown,
): value is SessionEntry & { type: "message"; message: { role: "user"; content: unknown } } {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as { type?: unknown; id?: unknown; message?: unknown };
	return (
		entry.type === "message" &&
		typeof entry.id === "string" &&
		typeof entry.message === "object" &&
		entry.message !== null &&
		(entry.message as { role?: unknown }).role === "user"
	);
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? [(part as { text: string }).text]
				: [],
		)
		.join("");
}

function samePeerConflictSides(
	coordination: CoordinationRecord,
	selectedWorkId: string,
	relatedWorkId: string,
): boolean {
	return (
		(coordination.workId === selectedWorkId && coordination.relatedWorkId === relatedWorkId) ||
		(coordination.workId === relatedWorkId && coordination.relatedWorkId === selectedWorkId)
	);
}

async function applyUserPriority(
	params: ApplyUserPriorityInput,
	context: ExtensionContext,
	options: SupervisionToolOptions,
) {
	assertConclave(context, options);
	const projectTrusted = isProjectTrusted(context);
	const priorityId = requireId(params.priorityId, "priorityId");
	const locked = withArchiveLock(context.cwd, projectTrusted, () => {
		const record = readUserPriority(context.cwd, priorityId, projectTrusted);
		if (record === undefined) {
			throw new Error(`No User Priority record exists for ID ${priorityId}.`);
		}
		if (record.status !== "pending") {
			throw new Error(`User Priority ${priorityId} is not pending (${record.status}).`);
		}
		const appliedOverride = listCoordinationRecords(context.cwd, projectTrusted).find(
			(candidate) => candidate.phase === "override" && candidate.priorityId === priorityId,
		);
		const coordination = projectCoordinations(context.cwd, projectTrusted).find(
			(candidate) =>
				candidate.coordinationId === record.coordinationId &&
				candidate.active &&
				candidate.latest.relation === "peer-conflict" &&
				samePeerConflictSides(candidate.latest, record.selectedWorkId, record.relatedWorkId),
		);
		if (coordination === undefined) {
			throw new Error(
				`User Priority ${priorityId} no longer matches its recorded active peer-conflict Coordination; dispose it instead.`,
			);
		}
		const decision = coordination.records.find((item) => item.phase === "decision");
		if (decision === undefined) {
			throw new Error(`Coordination ${record.coordinationId} has no recorded decision phase.`);
		}
		const primary = readCurrentMission(context.cwd, decision.workId, projectTrusted);
		const related = readCurrentMission(context.cwd, decision.relatedWorkId, projectTrusted);
		if (
			primary === undefined ||
			primary.state !== "current" ||
			primary.mission.missionId !== decision.missionId ||
			related === undefined ||
			related.state !== "current" ||
			related.mission.missionId !== decision.relatedMissionId
		) {
			throw new Error(`User Priority ${priorityId} targets a stale Mission; dispose it instead.`);
		}
		if (appliedOverride !== undefined) {
			return { kind: "replay" as const, details: appliedOverride, record, decision };
		}
		const selectedIsPrimary = record.selectedWorkId === decision.workId;
		let selectedExecutionId: string | undefined;
		if (selectedIsPrimary) {
			if (decision.executionId !== undefined) {
				selectedExecutionId = decision.executionId;
			}
		} else if (decision.relatedExecutionId !== undefined) {
			selectedExecutionId = decision.relatedExecutionId;
		}
		const override: CoordinationRecord = {
			coordinationId: record.coordinationId,
			actionId: record.actionId,
			phase: "override",
			relation: "peer-conflict",
			workId: decision.workId,
			missionId: decision.missionId,
			...(decision.executionId === undefined ? {} : { executionId: decision.executionId }),
			relatedWorkId: decision.relatedWorkId,
			relatedMissionId: decision.relatedMissionId,
			...(decision.relatedExecutionId === undefined ? {} : { relatedExecutionId: decision.relatedExecutionId }),
			selectedWorkId: record.selectedWorkId,
			selectedMissionId: selectedIsPrimary ? decision.missionId : decision.relatedMissionId,
			...(selectedExecutionId === undefined ? {} : { selectedExecutionId }),
			reason: `Applied pending User Priority ${priorityId}.`,
			userEntryId: record.provenance.entryId,
			priorityId,
		};
		const envelopeExecutionId = override.executionId;
		appendArchiveRecord(
			context.cwd,
			{
				schemaVersion: 2,
				type: "coordination",
				workId: override.workId,
				...(envelopeExecutionId === undefined ? {} : { executionId: envelopeExecutionId }),
				payload: override,
			},
			projectTrusted,
		);
		return { kind: "applied" as const, record, decision, override };
	});
	// The durable override is appended first; only then does the Conclave enforce
	// the priority by stopping the non-selected side through the mandatory-stop
	// protocol. Replays reconcile any persisted handoff or Intervention before
	// returning, so a crash cannot turn an applied priority into a lost stop.
	let stopError: string | undefined;
	try {
		await deliverPriorityStop(context, options, locked.record, locked.decision);
	} catch (error) {
		if (error instanceof Error) {
			stopError = error.message;
		} else {
			stopError = String(error);
		}
	}
	let text =
		locked.kind === "replay"
			? `User Priority ${priorityId} was already applied; enforcement replay reused.`
			: `Coordination override applied for User Priority ${priorityId}.`;
	if (stopError !== undefined) {
		text += ` The lower-priority Execution stop failed: ${stopError}.`;
	}
	const result = {
		content: [{ type: "text" as const, text }],
		details: locked.details ?? locked.override,
	};
	if (stopError !== undefined) {
		return { ...result, isError: true };
	}
	return result;
}

// Conclave-authorized consequence of an applied User Priority: the non-selected
// side is stopped through the existing mandatory-stop protocol and stop-handoff
// expectation. The Archive enforcement phases make replay continue from the last
// durable boundary instead of treating the Coordination override as completion.
function appendPriorityEnforcement(
	context: ExtensionContext,
	record: UserPriorityRecord,
	losing: Readonly<{ workId: string; missionId: string; executionId?: string }>,
	phase: (typeof UserPriorityEnforcementPhase)[keyof typeof UserPriorityEnforcementPhase],
	baselineSignalIds: readonly string[],
	evidence: Readonly<{
		stopEntryIds?: readonly string[];
		interventionId?: string;
		blockedSignalId?: string;
		terminalExecutionRecordId?: string;
	}>,
): UserPriorityEnforcementRecord {
	return withArchiveLock(context.cwd, isProjectTrusted(context), () => {
		const current = readUserPriorityEnforcement(context.cwd, record.priorityId, isProjectTrusted(context));
		const payload: UserPriorityEnforcementRecord = {
			priorityId: record.priorityId,
			coordinationId: record.coordinationId,
			workId: record.workId,
			selectedWorkId: record.selectedWorkId,
			relatedWorkId: record.relatedWorkId,
			losingWorkId: losing.workId,
			losingMissionId: losing.missionId,
			...(losing.executionId === undefined ? {} : { losingExecutionId: losing.executionId }),
			actionId: record.stopActionId,
			marker: supervisionMarker(record.stopActionId, "stop"),
			phase,
			baselineSignalIds: [...baselineSignalIds],
			...(evidence.stopEntryIds === undefined ? {} : { stopEntryIds: [...evidence.stopEntryIds] }),
			...(evidence.interventionId === undefined ? {} : { interventionId: evidence.interventionId }),
			...(evidence.blockedSignalId === undefined ? {} : { blockedSignalId: evidence.blockedSignalId }),
			...(evidence.terminalExecutionRecordId === undefined
				? {}
				: { terminalExecutionRecordId: evidence.terminalExecutionRecordId }),
		};
		if (current !== undefined) {
			if (JSON.stringify(current) === JSON.stringify(payload)) {
				return current;
			}
			if (current.phase === phase) {
				throw new Error(`User Priority ${record.priorityId} has conflicting enforcement evidence.`);
			}
		}
		appendArchiveRecord(
			context.cwd,
			{ schemaVersion: 2, type: "user-priority-enforcement", workId: record.workId, payload },
			isProjectTrusted(context),
		);
		return payload;
	});
}

function latestExecutionRecordId(
	projectPath: string,
	executionId: string,
	projectTrusted: boolean,
): string | undefined {
	return [...listArchiveRecords(projectPath, projectTrusted)]
		.reverse()
		.find((candidate) => candidate.type === "execution" && candidate.executionId === executionId)?.recordId;
}

function readPriorityBlockedSignalId(
	projectPath: string,
	projectTrusted: boolean,
	enforcement: UserPriorityEnforcementRecord,
	execution: ExecutorRecord,
): string | undefined {
	const missionProjection = readCurrentMission(projectPath, enforcement.losingWorkId, projectTrusted);
	if (
		missionProjection === undefined ||
		missionProjection.state !== "current" ||
		missionProjection.mission.missionId !== enforcement.losingMissionId ||
		execution.status !== ExecutorStatus.running ||
		execution.participantId === undefined
	) {
		return;
	}
	const baseline = new Set(enforcement.baselineSignalIds);
	const candidates = listArchiveRecords(projectPath, projectTrusted).flatMap((archiveRecord) => {
		if (
			archiveRecord.type !== "signal" ||
			!isSignal(archiveRecord.payload) ||
			baseline.has(archiveRecord.payload.signalId) ||
			archiveRecord.payload.workId !== enforcement.losingWorkId ||
			archiveRecord.payload.missionId !== enforcement.losingMissionId ||
			archiveRecord.payload.executionId !== enforcement.losingExecutionId ||
			archiveRecord.payload.participantId !== execution.participantId
		) {
			return [];
		}
		return [archiveRecord.payload];
	});
	if (candidates.length !== 1 || candidates[0]?.kind !== "blocked" || candidates[0].evidence.length === 0) {
		return;
	}
	return candidates[0].signalId;
}

async function deliverPriorityStop(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	record: UserPriorityRecord,
	decision: CoordinationRecord,
): Promise<void> {
	const key = `${resolve(context.cwd)}\u0000${record.priorityId}`;
	const existing = priorityStopDeliveries.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const delivery = deliverPriorityStopOnce(context, options, record, decision);
	priorityStopDeliveries.set(key, delivery);
	try {
		await delivery;
	} finally {
		if (priorityStopDeliveries.get(key) === delivery) {
			priorityStopDeliveries.delete(key);
		}
	}
}

async function deliverPriorityStopOnce(
	context: ExtensionContext,
	options: SupervisionToolOptions,
	record: UserPriorityRecord,
	decision: CoordinationRecord,
): Promise<void> {
	let losingWorkId = decision.workId;
	let losingMissionId = decision.missionId;
	let losingExecutionId = decision.executionId;
	if (record.selectedWorkId === decision.workId) {
		losingWorkId = decision.relatedWorkId;
		losingMissionId = decision.relatedMissionId;
		losingExecutionId = decision.relatedExecutionId;
	}
	const losing = {
		workId: losingWorkId,
		missionId: losingMissionId,
		...(losingExecutionId === undefined ? {} : { executionId: losingExecutionId }),
	};
	const projectTrusted = isProjectTrusted(context);
	let enforcement = readUserPriorityEnforcement(context.cwd, record.priorityId, projectTrusted);
	if (
		enforcement?.phase === UserPriorityEnforcementPhase.enforced ||
		enforcement?.phase === UserPriorityEnforcementPhase.terminal
	) {
		return;
	}
	if (losingExecutionId === undefined) {
		appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.enforced, [], {});
		return;
	}
	if (enforcement === undefined) {
		enforcement = appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.prepared, [], {});
	}
	const execution = readExecutorRecord(context.cwd, losingExecutionId, projectTrusted);
	if (execution?.status === ExecutorStatus.failed || execution?.status === ExecutorStatus.finished) {
		const terminalExecutionRecordId = latestExecutionRecordId(context.cwd, losingExecutionId, projectTrusted);
		if (terminalExecutionRecordId !== undefined) {
			appendPriorityEnforcement(
				context,
				record,
				losing,
				UserPriorityEnforcementPhase.terminal,
				enforcement.baselineSignalIds,
				{ terminalExecutionRecordId },
			);
		}
		return;
	}
	const control = (options.getRuntime ?? getHeadlessRuntime)(losingExecutionId);
	if (control === undefined) {
		let terminalExecutionRecordId = latestExecutionRecordId(context.cwd, losingExecutionId, projectTrusted);
		if (execution?.status === ExecutorStatus.starting || execution?.status === ExecutorStatus.running) {
			terminalExecutionRecordId = await failExecutionAndCloseInterventions(
				context.cwd,
				losingExecutionId,
				projectTrusted,
			);
		}
		if (terminalExecutionRecordId !== undefined) {
			appendPriorityEnforcement(
				context,
				record,
				losing,
				UserPriorityEnforcementPhase.terminal,
				enforcement.baselineSignalIds,
				{ terminalExecutionRecordId },
			);
		}
		return;
	}
	if (execution === undefined) {
		throw new Error(`Priority stop target Execution ${losingExecutionId} is unavailable.`);
	}
	const target = validateMissionExecution(context, losingWorkId, losingMissionId, losingExecutionId);
	const actionId = record.stopActionId;
	const reason = `Applied User Priority ${record.priorityId}; stop this lower-priority attempt.`;
	const message = "Submit the required blocked Signal before any further changes.";
	const stopParams: SteerInput = {
		assessmentId: record.priorityId,
		actionId,
		workId: losingWorkId,
		missionId: losingMissionId,
		executionId: losingExecutionId,
		mode: "stop",
		category: "dependency",
		missionTerm: target.mission.assignment.scope,
		reason,
		message,
		triggeringExecutorEntryIds: [],
	};
	validateSteerText(stopParams, target.mission);
	const marker = supervisionMarker(actionId, "stop");
	const targetMessage = mandatoryStopPrompt(reason, message);
	const existingInterventionRecord = listArchiveRecords(context.cwd, projectTrusted).find(
		(
			archiveRecordCandidate,
		): archiveRecordCandidate is typeof archiveRecordCandidate & {
			payload: InterventionIssuanceRecord;
		} =>
			archiveRecordCandidate.type === "intervention" &&
			typeof archiveRecordCandidate.payload === "object" &&
			archiveRecordCandidate.payload !== null &&
			(archiveRecordCandidate.payload as { phase?: unknown }).phase === "issuance" &&
			(archiveRecordCandidate.payload as { actionId?: unknown }).actionId === actionId,
	);
	let persistedEntryIds: readonly string[] = existingInterventionRecord?.payload.piEntryIds ?? [];
	let baselineSignalIds = enforcement.baselineSignalIds;
	try {
		if (existingInterventionRecord === undefined) {
			const persistedBeforeSend = await readMarkedEntriesFromRuntime(control, marker);
			const runtimeStopPending = control.isStopPending;
			const canReusePersistedHandoff = persistedBeforeSend.length > 0;
			if (canReusePersistedHandoff) {
				persistedEntryIds = persistedBeforeSend;
			} else if (runtimeStopPending === true) {
				throw new Error("Priority stop is already pending without a persisted handoff.");
			} else if (enforcement.phase === UserPriorityEnforcementPhase.baseline) {
				persistedEntryIds = await deliverStopHandoff(control, marker, targetMessage, options);
			} else {
				const delivered = await deliverMandatoryStop(
					context,
					options,
					control,
					marker,
					targetMessage,
					losingExecutionId,
					(signalIds) => {
						appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.baseline, signalIds, {});
					},
				);
				baselineSignalIds = delivered.baselineSignalIds;
				persistedEntryIds = delivered.persistedEntryIds;
			}
		}
		if (enforcement.phase === UserPriorityEnforcementPhase.prepared) {
			enforcement = appendPriorityEnforcement(
				context,
				record,
				losing,
				UserPriorityEnforcementPhase.baseline,
				baselineSignalIds,
				{},
			);
			baselineSignalIds = enforcement.baselineSignalIds;
		}
		if (enforcement.phase === UserPriorityEnforcementPhase.baseline) {
			enforcement = appendPriorityEnforcement(
				context,
				record,
				losing,
				UserPriorityEnforcementPhase.handoff,
				baselineSignalIds,
				{ stopEntryIds: persistedEntryIds },
			);
		}
	} catch (error) {
		emitStopEvent(options, losingExecutionId, "failed", errorMessage(error));
		const failedExecutionRecordId = await failRuntime(context, losingExecutionId, control);
		if (failedExecutionRecordId !== undefined) {
			appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.terminal, baselineSignalIds, {
				terminalExecutionRecordId: failedExecutionRecordId,
			});
		}
		throw new Error(
			`Priority stop delivery failed; Execution ${losingExecutionId} was marked failed: ${errorMessage(error)}`,
		);
	}
	const issuance =
		existingInterventionRecord?.payload ??
		createIssuance(context.cwd, stopParams, target, persistedEntryIds, targetMessage);
	const archiveRecord =
		existingInterventionRecord ??
		appendArchiveRecord(
			context.cwd,
			{
				schemaVersion: 2,
				type: "intervention",
				workId: issuance.workId,
				executionId: issuance.executionId,
				payload: issuance,
			},
			projectTrusted,
		);
	const establishedBlockedSignalId = readPriorityBlockedSignalId(context.cwd, projectTrusted, enforcement, execution);
	if (establishedBlockedSignalId !== undefined) {
		appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.enforced, baselineSignalIds, {
			stopEntryIds: persistedEntryIds,
			interventionId: issuance.interventionId,
			blockedSignalId: establishedBlockedSignalId,
		});
		return;
	}
	const expectationKey = `${losingExecutionId}:${issuance.interventionId}`;
	const registered = priorityStopExpectationRegistrations.get(options);
	if (registered?.has(expectationKey)) {
		return;
	}
	await registerStopExpectation(
		context,
		options,
		stopParams,
		target,
		issuance,
		archiveRecord,
		control,
		baselineSignalIds,
		async (enforcedSignalId) => {
			const current = readUserPriorityEnforcement(context.cwd, record.priorityId, projectTrusted);
			if (
				current?.phase === UserPriorityEnforcementPhase.enforced ||
				current?.phase === UserPriorityEnforcementPhase.terminal
			) {
				return;
			}
			appendPriorityEnforcement(context, record, losing, UserPriorityEnforcementPhase.enforced, baselineSignalIds, {
				stopEntryIds: persistedEntryIds,
				interventionId: issuance.interventionId,
				blockedSignalId: enforcedSignalId,
			});
		},
	);
	if (options.registerStopHandoffExpectation !== undefined) {
		const next = registered ?? new Set<string>();
		next.add(expectationKey);
		priorityStopExpectationRegistrations.set(options, next);
	}
}

function disposeUserPriority(
	params: DisposeUserPriorityInput,
	context: ExtensionContext,
	options: SupervisionToolOptions,
) {
	assertConclave(context, options);
	const projectTrusted = isProjectTrusted(context);
	const priorityId = requireId(params.priorityId, "priorityId");
	const reason = boundedReason(params.reason, "Priority disposition reason");
	return withArchiveLock(context.cwd, projectTrusted, () => {
		const existing = readUserPriority(context.cwd, priorityId, projectTrusted);
		if (existing === undefined) {
			throw new Error(`No User Priority record exists for ID ${priorityId}.`);
		}
		if (existing.status === "ignored") {
			if (existing.ignoredReason === reason) {
				return toolResult(`User Priority ${priorityId} ignored disposition replay reused.`, existing);
			}
			throw new Error(`User Priority ${priorityId} was already ignored with different evidence.`);
		}
		if (existing.status !== "pending") {
			throw new Error(`User Priority ${priorityId} is not pending.`);
		}
		if (isUserPriorityApplied(context.cwd, priorityId, projectTrusted)) {
			throw new Error(`User Priority ${priorityId} is already applied; it cannot be ignored.`);
		}
		// Disposal is refused only while the exact recorded Coordination remains
		// active and matches the Work pair; a replacement Coordination for the
		// same pair does not inherit old User intent.
		const active = projectCoordinations(context.cwd, projectTrusted).some(
			(candidate) =>
				candidate.coordinationId === existing.coordinationId &&
				candidate.active &&
				candidate.latest.relation === "peer-conflict" &&
				samePeerConflictSides(candidate.latest, existing.selectedWorkId, existing.relatedWorkId),
		);
		if (active) {
			throw new Error("User Priority still matches an active peer-conflict Coordination; record the override instead.");
		}
		const ignored: UserPriorityRecord = {
			...existing,
			status: "ignored",
			ignoredAt: new Date().toISOString(),
			ignoredReason: reason,
		};
		appendArchiveRecord(
			context.cwd,
			{ schemaVersion: 2, type: "user-priority", workId: existing.workId, payload: ignored },
			projectTrusted,
		);
		return toolResult(`User Priority ${priorityId} marked ignored.`, ignored);
	});
}

function validateObservedEntries(
	execution: ExecutorRecord,
	entryIds: readonly string[],
	issuanceEntryIds: readonly string[],
): void {
	if (execution.sessionPath === undefined || !existsSync(execution.sessionPath)) {
		throw new Error("The target Executor Pi session is unavailable for outcome evidence.");
	}
	const entries = readFileSync(execution.sessionPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [
					JSON.parse(line) as {
						id?: unknown;
						type?: unknown;
						message?: { role?: unknown };
					},
				];
			} catch {
				return [];
			}
		});
	const indexes = new Map(
		entries.flatMap((entry, index) => (typeof entry.id === "string" ? [[entry.id, index] as const] : [])),
	);
	const issuanceIndexes = issuanceEntryIds.flatMap((id) => {
		const index = indexes.get(id);
		return index === undefined ? [] : [index];
	});
	if (issuanceIndexes.length !== issuanceEntryIds.length || issuanceIndexes.length === 0) {
		throw new Error("Intervention issuance Pi entries are unavailable from the target session.");
	}
	const issuanceEnd = Math.max(...issuanceIndexes);
	if (new Set(entryIds).size !== entryIds.length) {
		throw new Error("Intervention outcome contains duplicate target Pi entry IDs.");
	}
	for (const id of entryIds) {
		const index = indexes.get(id);
		const entry = index === undefined ? undefined : entries[index];
		if (
			index === undefined ||
			index <= issuanceEnd ||
			entry?.type !== "message" ||
			(entry.message?.role !== "assistant" && entry.message?.role !== "toolResult")
		) {
			throw new Error("Intervention outcome requires later Executor response or tool-result Pi entries.");
		}
	}
}

function readArchiveBindings(
	context: ExtensionContext,
	workId: string,
	missionId: string,
	executionId: string,
): { missionRecordId: string; executionRecordId: string } {
	currentMission(context.cwd, workId, missionId, isProjectTrusted(context));
	const records = listArchiveRecords(context.cwd, isProjectTrusted(context));
	const missionRecord = [...records]
		.reverse()
		.find(
			(record) =>
				record.type === "mission" &&
				record.workId === workId &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { missionId?: unknown }).missionId === missionId,
		);
	const executionRecord = [...records]
		.reverse()
		.find((record) => record.type === "execution" && record.workId === workId && record.executionId === executionId);
	if (missionRecord === undefined || executionRecord === undefined) {
		throw new Error("Intervention outcome target Archive bindings are unavailable.");
	}
	return { missionRecordId: missionRecord.recordId, executionRecordId: executionRecord.recordId };
}

function validateResultingReferences(
	projectPath: string,
	projectTrusted: boolean,
	params: OutcomeInput,
	target: ExecutorRecord,
	expectedConclaveParticipantId: string,
): void {
	if (
		params.resultingSignalId !== undefined &&
		!listSignalRecords(projectPath, projectTrusted).some(
			(item) =>
				item.signalId === params.resultingSignalId &&
				item.workId === params.workId &&
				item.executionId === params.executionId &&
				item.missionId === params.missionId &&
				item.participantId === target.participantId,
		)
	)
		throw new Error("resultingSignalId is not a target Mission Signal.");
	if (
		params.resultingVerdictId !== undefined &&
		!listVerdictRecords(projectPath, projectTrusted).some(
			(item) =>
				item.verdictId === params.resultingVerdictId &&
				item.workId === params.workId &&
				item.executionId === params.executionId &&
				item.missionId === params.missionId &&
				(item.issuedByParticipantId === undefined || item.issuedByParticipantId === expectedConclaveParticipantId),
		)
	)
		throw new Error("resultingVerdictId is not a target Mission Verdict.");
	if (
		params.resultingExecutionId !== undefined &&
		!listExecutionRecords(projectPath, projectTrusted).some(
			(item) =>
				item.executionId === params.resultingExecutionId &&
				item.workId === params.workId &&
				item.missionId === params.missionId &&
				item.participantId === target.participantId,
		)
	)
		throw new Error("resultingExecutionId is not a target Mission Execution.");
	if (
		params.resultingCoordinationId !== undefined &&
		!listCoordinationRecords(projectPath, projectTrusted).some(
			(item) =>
				item.coordinationId === params.resultingCoordinationId &&
				(item.workId === params.workId || item.relatedWorkId === params.workId),
		)
	)
		throw new Error("resultingCoordinationId is not a target Coordination.");
}

function createIssuance(
	projectPath: string,
	params: SteerInput,
	target: ReturnType<typeof validateMissionExecution>,
	piEntryIds: readonly string[],
	archiveMessage: string,
): InterventionIssuanceRecord {
	const interventionId = `intervention-${sha256(params.actionId)}`;
	return {
		interventionId,
		phase: "issuance",
		actionId: params.actionId,
		mode: params.mode,
		workId: params.workId,
		mandateId: target.mandateId,
		missionId: params.missionId,
		executionId: params.executionId,
		conclaveParticipantId: conclaveParticipantId(projectPath),
		executorParticipantId: target.executorParticipantId,
		piSessionId: target.execution.piSessionId as string,
		assessmentId: params.assessmentId,
		failureSummary: params.reason.trim(),
		category: params.category as InterventionFailureCategory,
		missionTerm: params.missionTerm.trim(),
		message: archiveMessage,
		messageSha256: sha256(archiveMessage),
		promptIdentity: target.execution.promptIdentity as NonNullable<ExecutorRecord["promptIdentity"]>,
		piEntryIds,
		sentAt: new Date().toISOString(),
		transportResult: "confirmed",
	};
}

function supervisionMarker(actionId: string, mode: InterventionMode): string {
	return `${SUPERVISION_MARKER_PREFIX}${mode}:${actionId}:`;
}

function mandatoryStopPrompt(reason: string, message: string): string {
	return [
		"Mandatory Khala stop. Do not modify, create, delete, or stage any files.",
		"Do not continue implementation. Submit exactly one current blocked khala_signal identifying the conflict or safety issue and its evidence.",
		`Reason: ${reason.trim()}`,
		`Bounded instruction: ${message.trim()}`,
	].join("\n");
}

function sameSteerReplay(issuance: InterventionIssuanceRecord, params: SteerInput): boolean {
	return (
		issuance.workId === params.workId &&
		issuance.missionId === params.missionId &&
		issuance.executionId === params.executionId &&
		issuance.assessmentId === params.assessmentId &&
		issuance.mode === params.mode &&
		issuance.category === params.category &&
		issuance.missionTerm === params.missionTerm.trim() &&
		issuance.failureSummary === params.reason.trim() &&
		issuance.message ===
			(params.mode === "stop" ? mandatoryStopPrompt(params.reason, params.message) : params.message.trim())
	);
}

function sameOutcomeReplay(record: InterventionOutcomeRecord, params: OutcomeInput): boolean {
	return (
		record.workId === params.workId &&
		record.missionId === params.missionId &&
		record.executionId === params.executionId &&
		record.outcome === params.outcome &&
		record.reason === params.reason.trim() &&
		JSON.stringify(record.observedEntryIds) === JSON.stringify(params.observedEntryIds) &&
		record.resultingSignalId === params.resultingSignalId &&
		record.resultingVerdictId === params.resultingVerdictId &&
		record.resultingCoordinationId === params.resultingCoordinationId &&
		record.resultingExecutionId === params.resultingExecutionId &&
		record.failedExecutionRecordId === params.failedExecutionRecordId
	);
}

function sameCoordinationReplay(record: CoordinationRecord, params: CoordinateInput): boolean {
	return (
		JSON.stringify(record) ===
		JSON.stringify({
			coordinationId: params.coordinationId,
			actionId: params.actionId,
			phase: params.phase,
			relation: params.relation,
			workId: params.workId,
			missionId: params.missionId,
			executionId: params.executionId,
			selectedWorkId: params.selectedWorkId,
			selectedMissionId: params.selectedMissionId,
			relatedWorkId: params.relatedWorkId,
			relatedMissionId: params.relatedMissionId,
			relatedExecutionId: params.relatedExecutionId,
			selectedExecutionId: params.selectedExecutionId,
			...(params.relation === "dependency"
				? {
						upstreamWorkId: params.relatedWorkId,
						upstreamMissionId: params.relatedMissionId,
						upstreamExecutionId: params.relatedExecutionId,
					}
				: {}),
			reason: params.reason.trim(),
			...(params.classification === undefined ? {} : { classification: params.classification }),
			...(params.remote === undefined ? {} : { remote: params.remote.trim() }),
			...(params.branch === undefined ? {} : { branch: params.branch.trim() }),
		})
	);
}

function readInterventionByAction(
	projectPath: string,
	actionId: string,
	projectTrusted: boolean,
): { payload: InterventionIssuanceRecord | InterventionOutcomeRecord } | undefined {
	return listInterventionRecords(projectPath, projectTrusted)
		.filter((record) => record.actionId === actionId)
		.map((payload) => ({ payload }))
		.at(-1);
}

function readCoordinationByAction(
	projectPath: string,
	actionId: string,
	projectTrusted: boolean,
): { payload: CoordinationRecord } | undefined {
	return listCoordinationRecords(projectPath, projectTrusted)
		.filter((record) => record.actionId === actionId)
		.map((payload) => ({ payload }))
		.at(-1);
}

function readInterventionIssuance(
	projectPath: string,
	interventionId: string,
	projectTrusted: boolean,
): InterventionIssuanceRecord | undefined {
	return listInterventionRecords(projectPath, projectTrusted).find(
		(record): record is InterventionIssuanceRecord =>
			record.phase === "issuance" && record.interventionId === interventionId,
	);
}

function listInterventionProjections(
	projectPath: string,
	projectTrusted: boolean,
): Array<{ issuance: InterventionIssuanceRecord; outstanding: boolean }> {
	const map = new Map<string, { issuance: InterventionIssuanceRecord; outstanding: boolean }>();
	for (const record of listInterventionRecords(projectPath, projectTrusted)) {
		if (record.phase === "issuance") map.set(record.interventionId, { issuance: record, outstanding: true });
		else {
			const prior = map.get(record.interventionId);
			if (prior !== undefined) prior.outstanding = false;
		}
	}
	return [...map.values()];
}

async function failRuntime(
	context: ExtensionContext,
	executionId: string,
	control: RuntimeControl,
): Promise<string | undefined> {
	return failExecutionAndCloseInterventions(context.cwd, executionId, isProjectTrusted(context), async () => {
		try {
			await control.closeProcess();
		} catch {
			// The failed Execution record remains the authoritative failure evidence.
		}
	});
}

type AssessmentStartData = Readonly<{
	assessmentId: string;
	workId: string;
	missionId: string;
	executionId: string;
	firstSourceEntryId: string;
	lastSourceEntryId: string;
	sourceEntryIds: readonly string[];
	actionIdNamespace: string;
}>;

function isAssessmentStartData(value: unknown): value is AssessmentStartData {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const assessmentId = candidate["assessmentId"];
	const sourceEntryIds = candidate["sourceEntryIds"];
	return (
		typeof assessmentId === "string" &&
		typeof candidate["workId"] === "string" &&
		typeof candidate["missionId"] === "string" &&
		typeof candidate["executionId"] === "string" &&
		typeof candidate["firstSourceEntryId"] === "string" &&
		typeof candidate["lastSourceEntryId"] === "string" &&
		Array.isArray(sourceEntryIds) &&
		sourceEntryIds.length > 0 &&
		sourceEntryIds.every((id) => typeof id === "string") &&
		candidate["actionIdNamespace"] === `action:${assessmentId}:`
	);
}

type AssessmentEntry = Extract<SessionEntry, { type: "custom" }> & { data: AssessmentStartData };

function isAssessmentEntry(value: SessionEntry): value is AssessmentEntry {
	return (
		value.type === "custom" &&
		value.customType === "khala-supervision-assessment-start" &&
		isAssessmentStartData(value.data)
	);
}

function isActionStart(value: unknown): value is ActionStart {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const source = candidate["source"];
	const target = candidate["target"];
	return (
		typeof candidate["assessmentId"] === "string" &&
		typeof candidate["actionId"] === "string" &&
		typeof candidate["actionKind"] === "string" &&
		typeof candidate["mode"] === "string" &&
		isActionTarget(target) &&
		isActionSource(source)
	);
}

function isActionTarget(value: unknown): value is ActionTargetInput {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return ["assessmentId", "actionId", "workId", "missionId", "executionId"].every(
		(key) => typeof candidate[key] === "string",
	);
}

function isActionSource(value: unknown): value is ActionStart["source"] {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const sourceEntryIds = candidate["sourceEntryIds"];
	return (
		typeof candidate["assessmentStartEntryId"] === "string" &&
		typeof candidate["firstSourceEntryId"] === "string" &&
		typeof candidate["lastSourceEntryId"] === "string" &&
		Array.isArray(sourceEntryIds) &&
		sourceEntryIds.every((id) => typeof id === "string") &&
		typeof candidate["missionRecordId"] === "string" &&
		typeof candidate["executionRecordId"] === "string"
	);
}

function isActionComplete(
	value: unknown,
): value is Readonly<{ actionId: string; assessmentId: string; archiveRecordId: string }> {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate["actionId"] === "string" &&
		typeof candidate["assessmentId"] === "string" &&
		typeof candidate["archiveRecordId"] === "string"
	);
}

function emitStopEvent(
	options: SupervisionToolOptions,
	executionId: string,
	state: SupervisionStopEvent["state"],
	error?: string,
): void {
	const event: SupervisionStopEvent = { executionId, state };
	if (error !== undefined) {
		options.onStopEvent?.({ ...event, error });
	} else {
		options.onStopEvent?.(event);
	}
}

function toolResult(text: string, details: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

function bounded(value: string, label: string): string {
	const result = value.trim();
	if (result.length === 0 || result.length > (label === "Mission term" ? MAX_TERM_LENGTH : MAX_MESSAGE_LENGTH))
		throw new Error(`${label} must be bounded and non-empty.`);
	return result;
}

function boundedReason(value: string, label: string): string {
	const result = value.trim();
	if (result.length === 0 || result.length > MAX_REASON_LENGTH || GENERIC_REASON.test(result))
		throw new Error(`${label} must be bounded, specific, and non-generic.`);
	return result;
}

function requireId(value: string, label: string): string {
	if (!SAFE_ID.test(value) || value.trim().length === 0) throw new Error(`${label} is invalid.`);
	return value;
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function conclaveParticipantId(projectPath: string): string {
	return `conclave:${sha256(resolve(projectPath)).slice(0, CONCLAVE_PARTICIPANT_HASH_LENGTH)}`;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export type { CoordinateInput, OutcomeInput, SteerInput, SupervisionStopEvent, SupervisionToolOptions };
export {
	COORDINATE_PARAMETERS,
	mandatoryStopPrompt,
	OUTCOME_PARAMETERS,
	recordCoordination,
	recordInterventionOutcome,
	registerKhalaSupervisionTools,
	STEER_PARAMETERS,
	steerExecution,
	supervisionMarker,
};
