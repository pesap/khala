// The User Priority tool replaces speaking in the dedicated Conclave session.
// It binds to the exact causal persisted User turn, resolves the single active
// peer-conflict Coordination, and records a durable request before waking the
// Conclave. It never mutates Coordination or Mission state.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import { projectCoordinations, readUserPriority } from "./khala-archive-projections.js";
import {
	type CoordinationRecord,
	MAX_PRIORITY_REASON_LENGTH,
	type UserPriorityRecord,
	UserPriorityStatus,
	type UserPriorityStatusValue,
} from "./khala-model.js";
import { isUserSessionRole, readSessionRole } from "./khala-role.js";
import { deterministicActionId } from "./khala-supervision.js";
import { resolveUserSourceBinding, sha256, type UserSourceBinding } from "./khala-user-session-binding.js";

const USER_PRIORITY_PARAMETERS = Type.Object({
	selectedWorkId: Type.String(),
	relatedWorkId: Type.Optional(Type.String()),
	reason: Type.String(),
});
type UserPriorityInput = Static<typeof USER_PRIORITY_PARAMETERS>;
type UserPriorityWake = (
	projectPath: string,
	priorityId: string,
	workId: string,
	projectTrusted?: boolean,
) => Promise<void>;
type UserPriorityDependencies = Readonly<{ wakeUserPriority: UserPriorityWake }>;
type ResolvedPriorityTarget = Readonly<{ coordinationId: string; selectedWorkId: string; relatedWorkId: string }>;

function registerKhalaUserPriority(pi: ExtensionAPI, dependencies: UserPriorityDependencies): void {
	pi.registerTool({
		name: "khala_prioritize_work",
		label: "Prioritize Khala Work",
		description:
			"Record a User priority that selected Work proceeds before related Work in an active peer-conflict Coordination.",
		promptSnippet: "Prioritize selected Work over related Work",
		executionMode: "sequential",
		parameters: USER_PRIORITY_PARAMETERS,
		execute: (...args) => {
			const [toolCallId, params, , , context] = args;
			return submitUserPriority(params, context, dependencies, toolCallId);
		},
	});
}

async function submitUserPriority(
	params: UserPriorityInput,
	context: ExtensionContext,
	dependencies: UserPriorityDependencies,
	toolCallId: string,
) {
	if (!isUserSessionRole(readSessionRole(context))) {
		throw new Error("Only a User may prioritize Khala Work.");
	}
	const selectedWorkId = params.selectedWorkId.trim();
	if (selectedWorkId.length === 0) {
		throw new Error("selectedWorkId is required.");
	}
	let relatedWorkId: string | undefined;
	if (params.relatedWorkId !== undefined && params.relatedWorkId.trim().length > 0) {
		relatedWorkId = params.relatedWorkId.trim();
	}
	if (selectedWorkId === relatedWorkId) {
		throw new Error("selectedWorkId and relatedWorkId must be distinct Work identities.");
	}
	const reason = boundedUserPriorityReason(params.reason);
	const projectTrusted = isProjectTrusted(context);
	const target = resolveActivePeerConflict(context.cwd, selectedWorkId, relatedWorkId, projectTrusted);
	const binding = resolveUserSourceBinding(context, toolCallId);
	const priorityId = priorityIdentifier(
		binding.sessionId,
		binding.entryId,
		target.selectedWorkId,
		target.relatedWorkId,
	);
	const record = persistUserPriority({ projectPath: context.cwd, projectTrusted, priorityId, target, reason, binding });
	let wakeError: string | undefined;
	try {
		await dependencies.wakeUserPriority(context.cwd, priorityId, target.selectedWorkId, projectTrusted);
	} catch (error) {
		if (error instanceof Error) {
			wakeError = error.message;
		} else {
			wakeError = String(error);
		}
	}
	let text = `User Priority ${priorityId} recorded: prioritize Work ${target.selectedWorkId} over Work ${target.relatedWorkId}.`;
	if (wakeError !== undefined) {
		text += ` Conclave wake failed: ${wakeError}. Recovery is available with /khala-recreate.`;
	}
	const result: {
		content: [{ type: "text"; text: string }];
		details: {
			priorityId: string;
			selectedWorkId: string;
			relatedWorkId: string;
			coordinationId: string;
			status: UserPriorityStatusValue;
		};
	} = {
		content: [{ type: "text" as const, text }],
		details: {
			priorityId,
			selectedWorkId: target.selectedWorkId,
			relatedWorkId: target.relatedWorkId,
			coordinationId: target.coordinationId,
			status: record.status,
		},
	};
	if (wakeError !== undefined) {
		return { ...result, isError: true };
	}
	return result;
}

function resolveActivePeerConflict(
	projectPath: string,
	selectedWorkId: string,
	relatedWorkId: string | undefined,
	projectTrusted: boolean,
): ResolvedPriorityTarget {
	const matches: ResolvedPriorityTarget[] = [];
	for (const projection of projectCoordinations(projectPath, projectTrusted)) {
		if (projection.active && projection.latest.relation === "peer-conflict") {
			const target = matchingPeerConflictTarget(projection.latest, selectedWorkId, relatedWorkId);
			if (target !== undefined) {
				matches.push(target);
			}
		}
	}
	if (matches.length === 0) {
		if (relatedWorkId === undefined) {
			throw new Error(`Work ${selectedWorkId} has no active peer-conflict Coordination to prioritize.`);
		}
		throw new Error(`No active peer-conflict Coordination matches Work ${selectedWorkId} and ${relatedWorkId}.`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Work ${selectedWorkId} has ${matches.length} active peer-conflict Coordinations; specify the related Work to disambiguate.`,
		);
	}
	return matches[0] as ResolvedPriorityTarget;
}

function matchingPeerConflictTarget(
	coordination: CoordinationRecord,
	selectedWorkId: string,
	relatedWorkId: string | undefined,
): ResolvedPriorityTarget | undefined {
	const involvesSelected = coordination.workId === selectedWorkId || coordination.relatedWorkId === selectedWorkId;
	if (!involvesSelected) {
		return;
	}
	if (relatedWorkId === undefined) {
		if (coordination.workId === selectedWorkId) {
			return { coordinationId: coordination.coordinationId, selectedWorkId, relatedWorkId: coordination.relatedWorkId };
		}
		return { coordinationId: coordination.coordinationId, selectedWorkId, relatedWorkId: coordination.workId };
	}
	const involvesRelated = coordination.workId === relatedWorkId || coordination.relatedWorkId === relatedWorkId;
	if (!involvesRelated) {
		return;
	}
	return { coordinationId: coordination.coordinationId, selectedWorkId, relatedWorkId };
}

function persistUserPriority(input: {
	projectPath: string;
	projectTrusted: boolean;
	priorityId: string;
	target: ResolvedPriorityTarget;
	reason: string;
	binding: UserSourceBinding;
}): UserPriorityRecord {
	const { projectPath, projectTrusted, priorityId, target, reason, binding } = input;
	return withArchiveLock(projectPath, projectTrusted, () => {
		const existing = readUserPriority(projectPath, priorityId, projectTrusted);
		if (existing !== undefined) {
			if (sameUserPriorityEvidence(existing, target, reason, binding)) {
				return existing;
			}
			throw new Error(`User Priority ${priorityId} has conflicting replay evidence.`);
		}
		const pending: UserPriorityRecord = {
			priorityId,
			workId: target.selectedWorkId,
			selectedWorkId: target.selectedWorkId,
			relatedWorkId: target.relatedWorkId,
			coordinationId: target.coordinationId,
			actionId: deterministicActionId(priorityId, "coordinate-override"),
			stopActionId: deterministicActionId(priorityId, "stop"),
			reason,
			provenance: binding,
			status: UserPriorityStatus.pending,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecord(
			projectPath,
			{ schemaVersion: 2, type: "user-priority", workId: target.selectedWorkId, payload: pending },
			projectTrusted,
		);
		return pending;
	});
}

function sameUserPriorityEvidence(
	record: UserPriorityRecord,
	target: ResolvedPriorityTarget,
	reason: string,
	binding: UserSourceBinding,
): boolean {
	return (
		record.selectedWorkId === target.selectedWorkId &&
		record.relatedWorkId === target.relatedWorkId &&
		record.coordinationId === target.coordinationId &&
		record.actionId ===
			deterministicActionId(
				priorityIdentifier(binding.sessionId, binding.entryId, target.selectedWorkId, target.relatedWorkId),
				"coordinate-override",
			) &&
		record.stopActionId ===
			deterministicActionId(
				priorityIdentifier(binding.sessionId, binding.entryId, target.selectedWorkId, target.relatedWorkId),
				"stop",
			) &&
		record.reason === reason &&
		record.provenance.sessionId === binding.sessionId &&
		record.provenance.entryId === binding.entryId &&
		record.provenance.contentSha256 === binding.contentSha256
	);
}

function priorityIdentifier(sessionId: string, entryId: string, selectedWorkId: string, relatedWorkId: string): string {
	return `priority-${sha256(`${sessionId}\u0000${entryId}\u0000${selectedWorkId}\u0000${relatedWorkId}`)}`;
}

function boundedUserPriorityReason(value: string): string {
	const reason = value.trim();
	if (reason.length === 0 || reason.length > MAX_PRIORITY_REASON_LENGTH) {
		throw new Error(
			`Priority reason must be bounded and non-empty (at most ${MAX_PRIORITY_REASON_LENGTH} characters).`,
		);
	}
	return reason;
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

export type { ResolvedPriorityTarget, UserPriorityDependencies, UserPriorityInput };
export {
	matchingPeerConflictTarget,
	persistUserPriority,
	priorityIdentifier,
	registerKhalaUserPriority,
	resolveActivePeerConflict,
	sameUserPriorityEvidence,
	submitUserPriority,
};
