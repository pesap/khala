// biome-ignore-all lint/complexity/useMaxParams: Verdict recording keeps role, signal, storage, and delivery dependencies explicit.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { listVerdictRecords } from "./khala-archive-projections.js";
import type { KhalaWork, RetryHandoff, VerdictRecord } from "./khala-model.js";
import { readSignal } from "./khala-signal.js";
import {
	materializeMissingRetrySuccessor,
	normalizeAssignment,
	recoverTerminalExecutionStates,
} from "./khala-verdict-recovery.js";
import { isSameVerdict, normalizeVerdictParams, processNewVerdict, verdictResult } from "./khala-verdict-support.js";

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const MISSION_ASSIGNMENT_PARAMETERS = Type.Object({
	title: Type.String(),
	objective: Type.String(),
	context: Type.String(),
	scope: Type.String(),
	acceptanceCriteria: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	plan: Type.Array(Type.String()),
	validation: Type.Array(Type.String()),
	costBudget: Type.Optional(
		Type.Object({
			conclaveMaxCostUsdPerTurn: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			executorMaxCostUsdPerTurn: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		}),
	),
});
const RETRY_HANDOFF_PARAMETERS = Type.Object({
	failedCriteria: Type.Array(Type.String()),
	completedWork: Type.Array(Type.String()),
	requiredChanges: Type.Array(Type.String()),
	nonGoals: Type.Array(Type.String()),
	validation: Type.Array(Type.String()),
});
const VERDICT_PARAMETERS = Type.Object({
	workId: Type.String(),
	executionId: Type.String(),
	signalId: Type.String(),
	decision: Type.Union([
		Type.Literal("continue"),
		Type.Literal("retry"),
		Type.Literal("finish"),
		Type.Literal("reject"),
	]),
	reason: Type.String(),
	retryHandoff: Type.Optional(RETRY_HANDOFF_PARAMETERS),
	successorAssignment: Type.Optional(MISSION_ASSIGNMENT_PARAMETERS),
});
type VerdictInput = Static<typeof VERDICT_PARAMETERS>;
type MissionAssignmentInput = Static<typeof MISSION_ASSIGNMENT_PARAMETERS>;
type NormalizedVerdictInput = Omit<VerdictInput, "retryHandoff" | "successorAssignment"> & {
	retryHandoff?: RetryHandoff;
	successorAssignment?: KhalaWork;
};
type ConclaveSessionCheck = (context: ExtensionContext) => boolean;
type VerdictDelivery = (projectPath: string, verdict: VerdictRecord, projectTrusted?: boolean) => Promise<void>;

function registerKhalaVerdict(
	pi: ExtensionAPI,
	isConclave: ConclaveSessionCheck,
	deliverVerdict: VerdictDelivery = async () => undefined,
): void {
	pi.registerTool({
		name: "khala_verdict",
		label: "Issue Khala Verdict",
		description: "Record the Conclave's evidence-grounded Continue, Retry, Finish, or Reject decision for one Signal.",
		promptSnippet: "Issue a durable Khala Conclave Verdict",
		parameters: VERDICT_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordVerdict(params, context, isConclave, deliverVerdict);
		},
	});
}

function recordVerdict(
	params: VerdictInput,
	context: ExtensionContext,
	isConclave: ConclaveSessionCheck,
	deliverVerdict: VerdictDelivery,
) {
	if (!isConclave(context)) {
		throw new Error("Only the dedicated project Conclave may issue a Verdict.");
	}
	const identifiers = [params.workId, params.executionId, params.signalId];
	if (identifiers.some((identifier) => !isSafeIdentifier(identifier))) {
		throw new Error("Verdict identifiers must contain only letters, numbers, hyphens, or underscores.");
	}
	const reason = params.reason.trim();
	if (reason.length === 0) {
		throw new Error("A Verdict requires a non-empty reason.");
	}
	const normalizedAssignment = normalizeAssignment(params.successorAssignment);
	const normalizedRetryHandoff = normalizeRetryHandoff(params.retryHandoff);
	const normalizedParams = normalizeVerdictParams(params, reason, normalizedRetryHandoff, normalizedAssignment);
	const projectTrusted = isProjectTrusted(context);
	recoverTerminalExecutionStates(context.cwd, projectTrusted);
	const signal = readSignal(context.cwd, params.signalId, projectTrusted);
	if (signal === undefined || signal.workId !== params.workId || signal.executionId !== params.executionId) {
		throw new Error("The Verdict must reference an existing Signal from the same Work execution.");
	}
	const existing = readVerdictForSignal(context.cwd, params.signalId, projectTrusted);
	if (existing !== undefined) {
		if (isSameVerdict(existing, normalizedParams)) {
			assertReplayableRetry(existing);
			if (
				existing.decision === "retry" &&
				existing.missionId !== undefined &&
				existing.successorAssignment !== undefined
			) {
				const materialized = materializeMissingRetrySuccessor(context.cwd, projectTrusted, existing);
				return deliverVerdict(context.cwd, existing, projectTrusted).then(() => verdictResult(existing, materialized));
			}
			return deliverVerdict(context.cwd, existing, projectTrusted).then(() => verdictResult(existing, false));
		}
		throw new Error("A conflicting Verdict already exists for this Signal.");
	}
	return processNewVerdict({
		params,
		context,
		signal,
		projectTrusted,
		normalizedParams,
		reason,
	}).then(async (result) => {
		await deliverVerdict(context.cwd, result.details, projectTrusted);
		return result;
	});
}

function assertReplayableRetry(verdict: VerdictRecord): void {
	if (verdict.decision === "retry" && verdict.retryHandoff === undefined) {
		throw new Error(`Retry Verdict ${verdict.verdictId} is missing its durable retry handoff.`);
	}
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function isSafeIdentifier(value: string): boolean {
	return SAFE_IDENTIFIER_PATTERN.test(value);
}

function readVerdictForSignal(
	projectPath: string,
	signalId: string,
	projectTrusted = false,
): VerdictRecord | undefined {
	let latest: VerdictRecord | undefined;
	for (const record of listVerdictRecords(projectPath, projectTrusted)) {
		if (record.signalId === signalId) {
			latest = record;
		}
	}
	return latest;
}

function readLatestVerdict(
	projectPath: string,
	executionId: string,
	projectTrusted = false,
): VerdictRecord | undefined {
	let latest: VerdictRecord | undefined;
	for (const record of listVerdictRecords(projectPath, projectTrusted)) {
		if (record.executionId === executionId) {
			latest = record;
		}
	}
	return latest;
}

function normalizeRetryHandoff(handoff: VerdictInput["retryHandoff"]): RetryHandoff | undefined {
	if (handoff === undefined) {
		return;
	}
	return {
		failedCriteria: handoff.failedCriteria.map((item) => item.trim()),
		completedWork: handoff.completedWork.map((item) => item.trim()),
		requiredChanges: handoff.requiredChanges.map((item) => item.trim()),
		nonGoals: handoff.nonGoals.map((item) => item.trim()),
		validation: handoff.validation.map((item) => item.trim()),
	};
}

export type { MissionAssignmentInput, NormalizedVerdictInput, VerdictDelivery, VerdictInput };
export { normalizeRetryHandoff, readLatestVerdict, recordVerdict, registerKhalaVerdict };
