import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { listVerdictRecords } from "./khala-archive-projections.js";
import type { KhalaWork, VerdictRecord } from "./khala-model.js";
import { readSignal } from "./khala-signal.js";
import { materializeMissingRetrySuccessor, normalizeAssignment } from "./khala-verdict-recovery.js";
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
	successorAssignment: Type.Optional(MISSION_ASSIGNMENT_PARAMETERS),
});
type VerdictInput = Static<typeof VERDICT_PARAMETERS>;
type MissionAssignmentInput = Static<typeof MISSION_ASSIGNMENT_PARAMETERS>;
type NormalizedVerdictInput = Omit<VerdictInput, "successorAssignment"> & { successorAssignment?: KhalaWork };
type ConclaveSessionCheck = (context: ExtensionContext) => boolean;
type RequeueSubmission = (projectPath: string, workId: string, projectTrusted?: boolean) => boolean;

function registerKhalaVerdict(
	pi: ExtensionAPI,
	isConclave: ConclaveSessionCheck,
	requeueSubmission: RequeueSubmission,
): void {
	pi.registerTool({
		name: "khala_verdict",
		label: "Issue Khala Verdict",
		description: "Record the Conclave's evidence-grounded Continue, Retry, Finish, or Reject decision for one Signal.",
		promptSnippet: "Issue a durable Khala Conclave Verdict",
		parameters: VERDICT_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return recordVerdict(params, context, isConclave, requeueSubmission);
		},
	});
}

function recordVerdict(
	params: VerdictInput,
	context: ExtensionContext,
	isConclave: ConclaveSessionCheck,
	requeueSubmission: RequeueSubmission,
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
	const normalizedParams = normalizeVerdictParams(params, reason, normalizedAssignment);
	const projectTrusted = isProjectTrusted(context);
	const signal = readSignal(context.cwd, params.signalId, projectTrusted);
	if (signal === undefined || signal.workId !== params.workId || signal.executionId !== params.executionId) {
		throw new Error("The Verdict must reference an existing Signal from the same Work execution.");
	}
	const existing = readVerdictForSignal(context.cwd, params.signalId, projectTrusted);
	if (existing !== undefined) {
		if (isSameVerdict(existing, normalizedParams)) {
			if (
				existing.decision === "retry" &&
				existing.missionId !== undefined &&
				existing.successorAssignment !== undefined
			) {
				const materialized = materializeMissingRetrySuccessor(context.cwd, projectTrusted, existing);
				return verdictResult(existing, materialized);
			}
			return verdictResult(existing, false);
		}
		throw new Error("A conflicting Verdict already exists for this Signal.");
	}
	return processNewVerdict({ params, context, signal, projectTrusted, requeueSubmission, normalizedParams, reason });
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

export type { MissionAssignmentInput, NormalizedVerdictInput, RequeueSubmission, VerdictInput };
export { readLatestVerdict, recordVerdict, registerKhalaVerdict };
