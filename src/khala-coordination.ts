// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Runtime coordination phases validate several independent publication and lifecycle fences.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Runtime phase validation stays in one auditable evidence boundary.
// biome-ignore-all lint/complexity/useMaxParams: Coordination successor identity remains explicit at the runtime boundary.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Coordination revision handling is one append-order transaction boundary.
// biome-ignore-all lint/style/noTernary: Optional phase fields are assembled explicitly in these immutable records.
// biome-ignore-all lint/style/noContinue: Dependency traversal uses bounded breadth-first frontier steps.
// Coordination runtime phases are evidence-only transitions. Model and User judgment
// enters through the structured coordination tool; these helpers only verify the
// already-persisted decision and supplied publication evidence.
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { appendArchiveRecord, appendArchiveRecords, listArchiveRecords, withArchiveLock } from "./khala-archive.js";
import {
	listCoordinationRecords,
	listExecutionRecords,
	listPullRequestRecords,
	listSignalRecords,
	listVerdictRecords,
	projectCoordinations,
	readCurrentMission,
	readMission,
	validateProspectiveCoordinationGraph,
} from "./khala-archive-projections.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import {
	type CoordinationDependent,
	type CoordinationRecord,
	type ExecutorRecord,
	ExecutorStatus,
	type MissionRecord,
	type UpstreamExecutionBase,
} from "./khala-model.js";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type PublishedHeadEvidence = Readonly<{
	remote: string;
	branch: string;
	headCommit: string;
	verifiedHeadCommit: string;
	observedAt: string;
}>;

type CoordinationPhaseInput = Readonly<{
	projectPath: string;
	projectTrusted?: boolean;
	coordinationId: string;
	actionId: string;
	releasedExecutionId?: string;
}>;

type TerminalResolutionEvidence = Readonly<{
	evidenceRecordId: string;
}>;

type UpstreamRevisionInput = Readonly<{
	projectPath: string;
	projectTrusted?: boolean;
	supersededBase: UpstreamExecutionBase;
	replacementHead: string | null;
	evidence: Readonly<{ remote: string; branch: string; headCommit: string | null; observedAt: string }>;
	directDependents: readonly CoordinationDependent[];
	closeRuntime?: (executionId: string) => Promise<void>;
}>;

type UpstreamRevisionHandling = Readonly<{
	workId: string;
	missionId: string;
	executionId?: string;
	coordinationId: string;
	invalidationRecordId: string;
	handling: "held" | "retry-required" | "same-mission-recovery-required" | "successor-materialized";
	successorMissionId?: string;
}>;

type UpstreamRevisionResult = Readonly<{
	replacementHead: string | null;
	coordinationIds: readonly string[];
	handlings: readonly UpstreamRevisionHandling[];
}>;
type RevisionTarget = Readonly<{ dependent: CoordinationDependent; source: UpstreamExecutionBase }>;

function orderCoordinationDependents(
	projectPath: string,
	upstreamWorkId: string,
	upstreamMissionId: string,
	projectTrusted = false,
): CoordinationDependent[] {
	const candidates = projectCoordinations(projectPath, projectTrusted)
		.filter((candidate) => candidate.active && candidate.latest.relation === "dependency")
		.map((candidate) => candidate.latest);
	const ordered: CoordinationDependent[] = [];
	const seen = new Set<string>();
	let frontier = [{ workId: upstreamWorkId, missionId: upstreamMissionId }];
	while (frontier.length > 0) {
		const next: Array<{ workId: string; missionId: string }> = [];
		for (const parent of frontier) {
			for (const latest of candidates) {
				if (latest.relatedWorkId !== parent.workId || latest.relatedMissionId !== parent.missionId) {
					continue;
				}
				const key = `${latest.workId}\u0000${latest.missionId}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				ordered.push({
					workId: latest.workId,
					missionId: latest.missionId,
					...(latest.executionId === undefined ? {} : { executionId: latest.executionId }),
					supersededHead: latest.upstreamHead ?? "",
				});
				next.push({ workId: latest.workId, missionId: latest.missionId });
			}
		}
		frontier = next;
	}
	return ordered;
}

function directRevisionDependents(
	projectPath: string,
	base: UpstreamExecutionBase,
	projectTrusted = false,
): CoordinationDependent[] {
	const dependents = new Map<string, CoordinationDependent>();
	for (const execution of listExecutionRecords(projectPath, projectTrusted)) {
		if (
			execution.upstreamBase?.workId !== base.workId ||
			execution.upstreamBase.missionId !== base.missionId ||
			execution.upstreamBase.executionId !== base.executionId ||
			execution.upstreamBase.remote !== base.remote ||
			execution.upstreamBase.branch !== base.branch ||
			execution.upstreamBase.headCommit !== base.headCommit ||
			execution.missionId === undefined
		) {
			continue;
		}
		const current = readCurrentMission(projectPath, execution.workId, projectTrusted);
		if (current?.mission.missionId !== execution.missionId || current.state === "superseded") {
			continue;
		}
		const dependent: CoordinationDependent = {
			workId: execution.workId,
			missionId: execution.missionId,
			executionId: execution.executionId,
			supersededHead: base.headCommit,
		};
		dependents.set(dependentKey(dependent), dependent);
	}
	for (const projection of projectCoordinations(projectPath, projectTrusted)) {
		const record = projection.latest;
		if (
			record.relation !== "dependency" ||
			record.upstreamWorkId !== base.workId ||
			record.upstreamMissionId !== base.missionId ||
			record.upstreamExecutionId !== base.executionId ||
			record.remote !== base.remote ||
			record.branch !== base.branch ||
			record.upstreamHead !== base.headCommit
		) {
			continue;
		}
		const current = readCurrentMission(projectPath, record.workId, projectTrusted);
		if (current?.mission.missionId !== record.missionId || current.state === "superseded") {
			continue;
		}
		const dependent: CoordinationDependent = {
			workId: record.workId,
			missionId: record.missionId,
			...(record.executionId === undefined ? {} : { executionId: record.executionId }),
			supersededHead: base.headCommit,
		};
		dependents.set(dependentKey(dependent), dependent);
	}
	return [...dependents.values()].sort((left, right) => dependentKey(left).localeCompare(dependentKey(right)));
}

function releaseCoordination(input: CoordinationPhaseInput & { evidence: PublishedHeadEvidence }): CoordinationRecord {
	const projectTrusted = input.projectTrusted ?? false;
	return withArchiveLock(input.projectPath, projectTrusted, () => {
		const projection = projectCoordinations(input.projectPath, projectTrusted).find(
			(candidate) => candidate.coordinationId === input.coordinationId,
		);
		if (
			projection === undefined ||
			!projection.active ||
			projection.latest.relation !== "dependency" ||
			(projection.latest.phase !== "decision" && projection.latest.phase !== "override")
		) {
			throw new Error(`Coordination ${input.coordinationId} is not an active dependency hold.`);
		}
		const decision = projection.records.find((record) => record.phase === "decision");
		if (decision === undefined || decision.upstreamExecutionId === undefined) {
			throw new Error("Coordination release requires a decision bound to an upstream Execution.");
		}
		if (
			!FULL_COMMIT_PATTERN.test(input.evidence.headCommit) ||
			input.evidence.verifiedHeadCommit !== input.evidence.headCommit
		) {
			throw new Error("Coordination release requires one exact verified published head commit.");
		}
		if (decision.remote !== input.evidence.remote || decision.branch !== input.evidence.branch) {
			throw new Error("Coordination release evidence targets a different remote or branch.");
		}
		const upstreamMission = readCurrentMission(input.projectPath, decision.upstreamWorkId as string, projectTrusted);
		if (
			upstreamMission === undefined ||
			upstreamMission.mission.missionId !== decision.upstreamMissionId ||
			(upstreamMission.state !== "current" && upstreamMission.state !== "finished")
		) {
			throw new Error("Coordination release upstream Mission is stale or unavailable.");
		}
		const finish = listVerdictRecords(input.projectPath, projectTrusted).find(
			(verdict) =>
				verdict.executionId === decision.upstreamExecutionId &&
				verdict.missionId === decision.upstreamMissionId &&
				verdict.decision === "finish",
		);
		if (finish === undefined) {
			throw new Error("Coordination release requires an upstream Finish Verdict.");
		}
		const pullRequest = listPullRequestRecords(input.projectPath, projectTrusted).find(
			(candidate) =>
				candidate.executionId === decision.upstreamExecutionId &&
				candidate.missionId === decision.upstreamMissionId &&
				candidate.headCommit === input.evidence.headCommit &&
				candidate.sourceBranch === decision.branch &&
				candidate.remoteConfirmedAt !== undefined &&
				candidate.status !== "closed",
		);
		if (pullRequest === undefined) {
			throw new Error("Coordination release requires remotely confirmed publication of the exact head.");
		}
		const release: CoordinationRecord = {
			...decision,
			coordinationId: input.coordinationId,
			actionId: input.actionId,
			phase: "release",
			upstreamHead: input.evidence.verifiedHeadCommit,
			remoteObservation: {
				remote: input.evidence.remote,
				branch: input.evidence.branch,
				headCommit: input.evidence.verifiedHeadCommit,
				observedAt: input.evidence.observedAt,
			},
			...(input.releasedExecutionId === undefined ? {} : { releasedExecutionId: input.releasedExecutionId }),
			reason: "Runtime verified the upstream Finish, publication, and exact remote head.",
		};
		return appendArchiveRecord(
			input.projectPath,
			{ schemaVersion: 2, type: "coordination", workId: release.workId, payload: release },
			projectTrusted,
		).payload as CoordinationRecord;
	});
}

function resolveCoordination(
	input: CoordinationPhaseInput &
		(
			| { resolution?: "released"; evidence?: never }
			| { resolution: "terminal-failure"; evidence: TerminalResolutionEvidence }
		),
): CoordinationRecord {
	const projectTrusted = input.projectTrusted ?? false;
	return withArchiveLock(input.projectPath, projectTrusted, () => {
		const projection = projectCoordinations(input.projectPath, projectTrusted).find(
			(candidate) => candidate.coordinationId === input.coordinationId,
		);
		if (projection === undefined || !projection.active) {
			throw new Error(`Coordination ${input.coordinationId} is not ready for resolution.`);
		}
		if (input.resolution === "terminal-failure") {
			return appendTerminalResolution(input, projection, projectTrusted);
		}
		if (projection.latest.phase !== "release" || input.releasedExecutionId === undefined) {
			throw new Error(`Coordination ${input.coordinationId} is not ready for released resolution.`);
		}
		const decision = projection.records.find((record) => record.phase === "decision");
		if (decision === undefined || decision.relation !== "dependency") {
			throw new Error("Released Coordination resolution requires its dependency decision.");
		}
		const execution = readExecutorRecord(input.projectPath, input.releasedExecutionId, projectTrusted);
		if (
			execution === undefined ||
			execution.workId !== decision.workId ||
			execution.missionId !== decision.missionId ||
			execution.status !== ExecutorStatus.running
		) {
			throw new Error("Released Coordination resolution requires the matching running waiting Execution.");
		}
		const release = projection.latest;
		if (release.releasedExecutionId !== undefined && release.releasedExecutionId !== input.releasedExecutionId) {
			throw new Error("Released Coordination resolution targets a different launched Execution.");
		}
		const base = execution.upstreamBase;
		if (
			base === undefined ||
			base.workId !== decision.upstreamWorkId ||
			base.missionId !== decision.upstreamMissionId ||
			base.executionId !== decision.upstreamExecutionId ||
			base.remote !== release.remote ||
			base.branch !== release.branch ||
			base.headCommit !== release.upstreamHead
		) {
			throw new Error("Released Coordination resolution requires the exact immutable upstream Execution base.");
		}
		const resolution: CoordinationRecord = {
			...release,
			coordinationId: input.coordinationId,
			actionId: input.actionId,
			phase: "resolution",
			resolution: "released",
			releasedExecutionId: input.releasedExecutionId,
			reason: "The held Execution launched successfully from the verified upstream head.",
		};
		return appendArchiveRecord(
			input.projectPath,
			{ schemaVersion: 2, type: "coordination", workId: resolution.workId, payload: resolution },
			projectTrusted,
		).payload as CoordinationRecord;
	});
}

function appendTerminalResolution(
	input: CoordinationPhaseInput & { resolution: "terminal-failure"; evidence: TerminalResolutionEvidence },
	projection: ReturnType<typeof projectCoordinations>[number],
	projectTrusted: boolean,
): CoordinationRecord {
	if (projection.latest.phase === "resolution") {
		throw new Error(`Coordination ${input.coordinationId} is already resolved.`);
	}
	const decision = projection.records.find((record) => record.phase === "decision");
	if (decision === undefined || decision.relation !== "dependency" || decision.branch === undefined) {
		throw new Error("Terminal Coordination resolution requires a dependency decision with a branch.");
	}
	const evidence = listArchiveRecords(input.projectPath, projectTrusted).find(
		(record) => record.recordId === input.evidence.evidenceRecordId,
	);
	if (evidence === undefined) {
		throw new Error("Terminal Coordination resolution requires an exact Archive evidence record ID.");
	}
	const upstreamExecution = readExecutorRecord(
		input.projectPath,
		decision.upstreamExecutionId as string,
		projectTrusted,
	);
	const evidencePayload = evidence.payload as {
		missionId?: unknown;
		decision?: unknown;
		status?: unknown;
		executionId?: unknown;
		sourceBranch?: unknown;
		remoteConfirmedAt?: unknown;
		mergeCommit?: unknown;
	};
	const isRejectVerdict =
		evidence.type === "verdict" &&
		evidence.workId === decision.upstreamWorkId &&
		evidence.executionId === decision.upstreamExecutionId &&
		evidencePayload.missionId === decision.upstreamMissionId &&
		evidencePayload.decision === "reject";
	const latestUpstreamExecutionRecord = [...listArchiveRecords(input.projectPath, projectTrusted)]
		.reverse()
		.find(
			(record) =>
				record.type === "execution" &&
				record.workId === decision.upstreamWorkId &&
				record.executionId === decision.upstreamExecutionId,
		);
	const isFailedExecution =
		evidence.type === "execution" &&
		evidence.recordId === latestUpstreamExecutionRecord?.recordId &&
		evidence.workId === decision.upstreamWorkId &&
		evidence.executionId === decision.upstreamExecutionId &&
		upstreamExecution?.status === ExecutorStatus.failed &&
		evidencePayload.status === ExecutorStatus.failed &&
		!listPullRequestRecords(input.projectPath, projectTrusted).some(
			(pullRequest) =>
				pullRequest.workId === decision.upstreamWorkId &&
				pullRequest.missionId === decision.upstreamMissionId &&
				pullRequest.executionId === decision.upstreamExecutionId &&
				pullRequest.status !== "closed" &&
				pullRequest.headCommit !== undefined &&
				pullRequest.remoteConfirmedAt !== undefined,
		);
	const isClosedWithoutMerge =
		evidence.type === "pull-request" &&
		evidence.workId === decision.upstreamWorkId &&
		evidencePayload.missionId === decision.upstreamMissionId &&
		evidencePayload.executionId === decision.upstreamExecutionId &&
		evidencePayload.status === "closed" &&
		evidencePayload.sourceBranch === decision.branch &&
		evidencePayload.remoteConfirmedAt !== undefined &&
		evidencePayload.mergeCommit === undefined;
	if (!(isRejectVerdict || isFailedExecution || isClosedWithoutMerge)) {
		throw new Error("Terminal Coordination resolution evidence is not an exact upstream terminal failure.");
	}
	const resolution: CoordinationRecord = {
		...projection.latest,
		coordinationId: input.coordinationId,
		actionId: input.actionId,
		phase: "resolution",
		resolution: "terminal-failure",
		resolutionEvidenceRecordId: input.evidence.evidenceRecordId,
		reason: "Runtime verified terminal upstream failure evidence; the held Work remains scheduling-blocked.",
	};
	return appendArchiveRecord(
		input.projectPath,
		{ schemaVersion: 2, type: "coordination", workId: resolution.workId, payload: resolution },
		projectTrusted,
	).payload as CoordinationRecord;
}

function resolveTerminalUpstreamCoordinations(
	projectPath: string,
	upstreamExecutionId: string,
	evidenceRecordId: string,
	projectTrusted = false,
): CoordinationRecord[] {
	const resolved: CoordinationRecord[] = [];
	for (const projection of projectCoordinations(projectPath, projectTrusted)) {
		const decision = projection.records.find((record) => record.phase === "decision");
		if (
			!projection.active ||
			decision?.relation !== "dependency" ||
			decision.upstreamExecutionId !== upstreamExecutionId
		) {
			continue;
		}
		const actionId = deterministicRevisionId(
			{
				kind: "upstream-execution",
				workId: decision.upstreamWorkId as string,
				missionId: decision.upstreamMissionId as string,
				executionId: upstreamExecutionId,
				remote: decision.remote as string,
				branch: decision.branch as string,
				headCommit: decision.upstreamHead ?? "terminal-before-release",
			},
			{
				workId: decision.workId,
				missionId: decision.missionId,
				...(decision.executionId === undefined ? {} : { executionId: decision.executionId }),
				supersededHead: decision.upstreamHead ?? "terminal-before-release",
			},
			`terminal-${evidenceRecordId}`,
		);
		try {
			resolved.push(
				resolveCoordination({
					projectPath,
					projectTrusted,
					coordinationId: projection.coordinationId,
					actionId,
					resolution: "terminal-failure",
					evidence: { evidenceRecordId },
				}),
			);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				error.message !== "Terminal Coordination resolution evidence is not an exact upstream terminal failure."
			) {
				throw error;
			}
		}
	}
	return resolved;
}

function invalidateCoordination(
	input: CoordinationPhaseInput & {
		supersededHead: string;
		replacementHead: string | null;
		affectedDependents: readonly CoordinationDependent[];
		evidence: Readonly<{ remote: string; branch: string; headCommit: string | null; observedAt: string }>;
	},
): CoordinationRecord {
	const projectTrusted = input.projectTrusted ?? false;
	return withArchiveLock(input.projectPath, projectTrusted, () => {
		const projection = projectCoordinations(input.projectPath, projectTrusted).find(
			(candidate) => candidate.coordinationId === input.coordinationId,
		);
		if (
			projection === undefined ||
			!projection.active ||
			projection.latest.relation !== "dependency" ||
			projection.latest.phase === "resolution"
		) {
			throw new Error(`Coordination ${input.coordinationId} is not an active invalidatable dependency.`);
		}
		if (projection.latest.upstreamHead !== undefined && projection.latest.upstreamHead !== input.supersededHead) {
			throw new Error("Coordination invalidation does not match the recorded upstream base.");
		}
		if (
			input.evidence.remote !== projection.latest.remote ||
			input.evidence.branch !== projection.latest.branch ||
			input.evidence.headCommit !== input.replacementHead
		) {
			throw new Error("Coordination invalidation replacement head does not match its remote observation.");
		}
		const invalidation: CoordinationRecord = {
			...projection.latest,
			coordinationId: input.coordinationId,
			actionId: input.actionId,
			phase: "invalidation",
			upstreamHead: input.supersededHead,
			replacementHead: input.replacementHead,
			affectedDependents: input.affectedDependents,
			remoteObservation: input.evidence,
			reason: "Runtime verified that the recorded upstream base is no longer the published head.",
		};
		return appendArchiveRecord(
			input.projectPath,
			{ schemaVersion: 2, type: "coordination", workId: invalidation.workId, payload: invalidation },
			projectTrusted,
		).payload as CoordinationRecord;
	});
}

function materializeCoordinationSuccessor(
	projectPath: string,
	workId: string,
	predecessorMissionId: string,
	coordinationId: string,
	projectTrusted = false,
): MissionRecord {
	return withArchiveLock(projectPath, projectTrusted, () => {
		const predecessor = readMission(projectPath, predecessorMissionId, projectTrusted);
		const predecessorProjection = readCurrentMission(projectPath, workId, projectTrusted);
		if (predecessor === undefined || predecessor.workId !== workId) {
			throw new Error("Coordination successor requires the exact predecessor Mission.");
		}
		const existing = listArchiveRecords(projectPath, projectTrusted).find(
			(record) =>
				record.type === "mission" &&
				record.workId === workId &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { predecessorMissionId?: unknown }).predecessorMissionId === predecessorMissionId,
		);
		if (existing?.type === "mission") {
			const payload = existing.payload as MissionRecord;
			if (payload.causedByCoordinationId !== coordinationId) {
				throw new Error("A predecessor Mission already has a successor caused by different evidence.");
			}
			return payload;
		}
		const predecessorReviewable = listPullRequestRecords(projectPath, projectTrusted).some(
			(review) => review.missionId === predecessorMissionId && review.status === "reviewable",
		);
		if (predecessorProjection?.mission.missionId !== predecessorMissionId && !predecessorReviewable) {
			throw new Error("Coordination successor requires the exact predecessor Mission.");
		}
		const retrySuccessor = listArchiveRecords(projectPath, projectTrusted).find(
			(record) =>
				record.type === "mission" &&
				record.workId === workId &&
				typeof record.payload === "object" &&
				record.payload !== null &&
				(record.payload as { predecessorMissionId?: unknown }).predecessorMissionId === predecessorMissionId &&
				(record.payload as { causedByVerdictId?: unknown }).causedByVerdictId !== undefined,
		);
		if (retrySuccessor !== undefined) {
			throw new Error("A Retry successor already superseded this predecessor Mission; Coordination cannot reuse it.");
		}
		const invalidation = listCoordinationRecords(projectPath, projectTrusted).find(
			(record) =>
				record.coordinationId === coordinationId &&
				record.phase === "invalidation" &&
				record.workId === workId &&
				record.affectedDependents?.some((dependent) => dependent.missionId === predecessorMissionId),
		);
		if (
			invalidation === undefined ||
			invalidation.upstreamHead === undefined ||
			!invalidation.affectedDependents?.some(
				(dependent) =>
					dependent.workId === workId &&
					dependent.missionId === predecessorMissionId &&
					dependent.supersededHead === invalidation.upstreamHead,
			)
		) {
			throw new Error("Coordination successor requires an invalidation involving the exact predecessor Mission.");
		}
		const missionId = nanoid();
		const successor: MissionRecord = {
			missionId,
			workId,
			mandateId: predecessor.mandateId,
			predecessorMissionId,
			causedByCoordinationId: coordinationId,
			assignment: predecessor.assignment,
			assignedParticipantId: `executor:${missionId}`,
			createdAt: new Date().toISOString(),
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mission", workId, payload: successor }, projectTrusted);
		return successor;
	});
}

async function recordUpstreamRevision(input: UpstreamRevisionInput): Promise<UpstreamRevisionResult> {
	const projectTrusted = input.projectTrusted ?? false;
	if (
		!FULL_COMMIT_PATTERN.test(input.supersededBase.headCommit) ||
		input.evidence.remote !== input.supersededBase.remote ||
		input.evidence.branch !== input.supersededBase.branch ||
		input.evidence.headCommit !== input.replacementHead ||
		(input.replacementHead !== null && !FULL_COMMIT_PATTERN.test(input.replacementHead))
	) {
		throw new Error("Upstream revision evidence must match the exact immutable base and replacement head.");
	}
	if (input.closeRuntime !== undefined) {
		const affectedExecutionIds = new Set(
			[
				...input.directDependents,
				...orderCoordinationDependents(
					input.projectPath,
					input.supersededBase.workId,
					input.supersededBase.missionId,
					projectTrusted,
				),
			].flatMap((dependent) => (dependent.executionId === undefined ? [] : [dependent.executionId])),
		);
		for (const executionId of affectedExecutionIds) {
			const execution = readExecutorRecord(input.projectPath, executionId, projectTrusted);
			if (execution?.status !== ExecutorStatus.running) {
				continue;
			}
			const signals = listSignalRecords(input.projectPath, projectTrusted).filter(
				(signal) =>
					signal.executionId === executionId &&
					signal.missionId === execution.missionId &&
					signal.participantId === execution.participantId,
			);
			if (signals.at(-1)?.kind === "blocked") {
				continue;
			}
			// biome-ignore lint/performance/noAwaitInLoops: Runtime ownership must close each child before its failed Archive transition.
			await input.closeRuntime(executionId);
			updateExecutorRecord(input.projectPath, executionId, { status: ExecutorStatus.failed }, projectTrusted);
		}
	}
	return withArchiveLock(input.projectPath, projectTrusted, () => {
		const coordinations = projectCoordinations(input.projectPath, projectTrusted);
		const prior = coordinations.some(
			(candidate) =>
				candidate.resolved &&
				candidate.latest.relation === "dependency" &&
				candidate.latest.upstreamWorkId === input.supersededBase.workId &&
				candidate.latest.upstreamMissionId === input.supersededBase.missionId &&
				candidate.latest.upstreamExecutionId === input.supersededBase.executionId &&
				candidate.latest.upstreamHead === input.supersededBase.headCommit &&
				candidate.latest.remote === input.supersededBase.remote &&
				candidate.latest.branch === input.supersededBase.branch,
		);
		if (!prior) {
			throw new Error("Upstream revision requires a resolved Coordination for the exact superseded base.");
		}
		const executions = latestExecutions(input.projectPath, projectTrusted);
		const dependentEdges = buildDependentEdges(input.projectPath, projectTrusted, executions);
		const sourceBases = buildSourceBases(input.projectPath, projectTrusted, input.supersededBase, executions);
		assertRevisionGraphAcyclic(dependentEdges);
		const direct = dependentEdges.get(sourceKey(input.supersededBase)) ?? [];
		assertExactDirectDependents(input.directDependents, direct, input.supersededBase.headCommit);
		const ordered = collectRevisionDependents(
			input.projectPath,
			projectTrusted,
			input.supersededBase,
			dependentEdges,
			executions,
			sourceBases,
		);
		const handlings: UpstreamRevisionHandling[] = [];
		const coordinationIds: string[] = [];
		const invalidationCauseByDependent = new Map<string, string>();
		for (const { dependent, source } of ordered) {
			const current = readCurrentMission(input.projectPath, dependent.workId, projectTrusted);
			if (
				current === undefined ||
				current.mission.missionId !== dependent.missionId ||
				current.state === "superseded"
			) {
				continue;
			}
			const coordinationId = deterministicRevisionId(source, dependent, "coordination");
			const decisionActionId = deterministicRevisionId(source, dependent, "decision");
			const invalidationActionId = deterministicRevisionId(source, dependent, "invalidation");
			const transitive = sourceKey(source) !== sourceKey(input.supersededBase);
			const transitiveCause = transitive
				? invalidationCauseByDependent.get(
						dependentKey({
							workId: source.workId,
							missionId: source.missionId,
							executionId: source.executionId,
						}),
					)
				: undefined;
			if (transitive && transitiveCause === undefined) {
				throw new Error("Transitive invalidation lacks its preceding upstream Coordination cause.");
			}
			const decision: CoordinationRecord = {
				coordinationId,
				actionId: decisionActionId,
				phase: "decision",
				relation: "dependency",
				workId: dependent.workId,
				missionId: dependent.missionId,
				selectedWorkId: source.workId,
				selectedMissionId: source.missionId,
				selectedExecutionId: source.executionId,
				relatedWorkId: source.workId,
				relatedMissionId: source.missionId,
				relatedExecutionId: source.executionId,
				...(dependent.executionId === undefined ? {} : { executionId: dependent.executionId }),
				upstreamWorkId: source.workId,
				upstreamMissionId: source.missionId,
				upstreamExecutionId: source.executionId,
				remote: source.remote,
				branch: source.branch,
				reason:
					"The exact upstream Execution base changed; the dependent must be rerun from a viable replacement head.",
			};
			validateProspectiveCoordinationGraph(listCoordinationRecords(input.projectPath, projectTrusted), decision);
			const invalidation: CoordinationRecord = {
				...decision,
				actionId: invalidationActionId,
				phase: "invalidation",
				upstreamHead: source.headCommit,
				affectedDependents: [
					{
						workId: dependent.workId,
						missionId: dependent.missionId,
						...(dependent.executionId === undefined ? {} : { executionId: dependent.executionId }),
						supersededHead: source.headCommit,
					},
				],
				...(transitive
					? {
							causedByCoordinationId: transitiveCause as string,
							reason: "The preceding upstream Coordination invalidation transitively invalidated this exact base.",
						}
					: {
							replacementHead: input.replacementHead,
							remoteObservation: input.evidence,
							reason: "Runtime verified that the exact upstream base is superseded.",
						}),
			};
			const appended = appendArchiveRecords(
				input.projectPath,
				[
					{ schemaVersion: 2, type: "coordination", workId: decision.workId, payload: decision },
					{ schemaVersion: 2, type: "coordination", workId: invalidation.workId, payload: invalidation },
				],
				projectTrusted,
			);
			const invalidationRecord = appended[1] as NonNullable<(typeof appended)[number]>;
			coordinationIds.push(coordinationId);
			invalidationCauseByDependent.set(dependentKey(dependent), coordinationId);
			const handling = applyInvalidationHandling(
				input.projectPath,
				projectTrusted,
				dependent,
				coordinationId,
				invalidationRecord.recordId,
			);
			handlings.push(handling);
		}
		return { replacementHead: input.replacementHead, coordinationIds, handlings };
	});
}

function latestExecutions(projectPath: string, projectTrusted: boolean): Map<string, ExecutorRecord> {
	const executions = new Map<string, ExecutorRecord>();
	for (const execution of listExecutionRecords(projectPath, projectTrusted)) {
		executions.set(execution.executionId, execution);
	}
	return executions;
}

function sourceKey(
	base: Readonly<{ workId: string; missionId: string; executionId: string; headCommit: string }>,
): string {
	return `${base.workId}\u0000${base.missionId}\u0000${base.executionId}\u0000${base.headCommit}`;
}

function dependentKey(dependent: Readonly<{ workId: string; missionId: string; executionId?: string }>): string {
	return `${dependent.workId}\u0000${dependent.missionId}\u0000${dependent.executionId ?? ""}`;
}

function buildDependentEdges(
	projectPath: string,
	projectTrusted: boolean,
	executions: ReadonlyMap<string, ExecutorRecord>,
): Map<string, CoordinationDependent[]> {
	const edges = new Map<string, CoordinationDependent[]>();
	const add = (key: string, dependent: CoordinationDependent): void => {
		const current = edges.get(key) ?? [];
		if (!current.some((candidate) => dependentKey(candidate) === dependentKey(dependent))) {
			current.push(dependent);
			current.sort((left, right) => dependentKey(left).localeCompare(dependentKey(right)));
		}
		edges.set(key, current);
	};
	for (const execution of executions.values()) {
		if (
			execution.upstreamBase === undefined ||
			execution.missionId === undefined ||
			readCurrentMission(projectPath, execution.workId, projectTrusted)?.mission.missionId !== execution.missionId
		) {
			continue;
		}
		add(sourceKey(execution.upstreamBase), {
			workId: execution.workId,
			missionId: execution.missionId as string,
			executionId: execution.executionId,
			supersededHead: execution.upstreamBase.headCommit,
		});
	}
	for (const record of listCoordinationRecords(projectPath, projectTrusted)) {
		if (
			record.relation !== "dependency" ||
			readCurrentMission(projectPath, record.workId, projectTrusted)?.mission.missionId !== record.missionId ||
			record.upstreamWorkId === undefined ||
			record.upstreamMissionId === undefined ||
			record.upstreamExecutionId === undefined ||
			record.upstreamHead === undefined
		) {
			continue;
		}
		add(
			sourceKey({
				workId: record.upstreamWorkId,
				missionId: record.upstreamMissionId,
				executionId: record.upstreamExecutionId,
				headCommit: record.upstreamHead,
			}),
			{
				workId: record.workId,
				missionId: record.missionId,
				...(record.executionId === undefined ? {} : { executionId: record.executionId }),
				supersededHead: record.upstreamHead,
			},
		);
	}
	return edges;
}

function assertRevisionGraphAcyclic(edges: ReadonlyMap<string, readonly CoordinationDependent[]>): void {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (key: string): void => {
		if (visiting.has(key)) {
			throw new Error("Upstream revision dependency graph contains a cycle.");
		}
		if (visited.has(key)) {
			return;
		}
		visiting.add(key);
		for (const dependent of edges.get(key) ?? []) {
			for (const next of edges.keys()) {
				if (
					next.startsWith(`${dependent.workId}\u0000${dependent.missionId}\u0000${dependent.executionId ?? ""}\u0000`)
				) {
					visit(next);
				}
			}
		}
		visiting.delete(key);
		visited.add(key);
	};
	for (const key of edges.keys()) {
		visit(key);
	}
}

function assertExactDirectDependents(
	supplied: readonly CoordinationDependent[],
	derived: readonly CoordinationDependent[],
	supersededHead: string,
): void {
	const suppliedKeys = new Set(supplied.map(dependentKey));
	const derivedKeys = new Set(derived.map(dependentKey));
	if (
		supplied.some((dependent) => dependent.supersededHead !== supersededHead) ||
		suppliedKeys.size !== derivedKeys.size ||
		[...suppliedKeys].some((key) => !derivedKeys.has(key))
	) {
		throw new Error("Upstream revision direct dependents do not match immutable-base evidence.");
	}
}

function collectRevisionDependents(
	projectPath: string,
	projectTrusted: boolean,
	base: UpstreamExecutionBase,
	edges: ReadonlyMap<string, readonly CoordinationDependent[]>,
	executions: ReadonlyMap<string, ExecutorRecord>,
	sourceBases: ReadonlyMap<string, UpstreamExecutionBase>,
): RevisionTarget[] {
	const ordered: RevisionTarget[] = [];
	const seen = new Set<string>();
	const queue = [sourceKey(base)];
	while (queue.length > 0) {
		const key = queue.shift() as string;
		const source = sourceBases.get(key);
		if (source === undefined) {
			throw new Error("Immutable upstream source evidence is unavailable.");
		}
		for (const dependent of edges.get(key) ?? []) {
			const identity = dependentKey(dependent);
			if (seen.has(identity)) {
				continue;
			}
			const current = readCurrentMission(projectPath, dependent.workId, projectTrusted);
			if (current === undefined || current.state === "superseded") {
				continue;
			}
			seen.add(identity);
			ordered.push({ dependent, source });
			const execution = dependent.executionId === undefined ? undefined : executions.get(dependent.executionId);
			if (execution?.projectPath !== undefined) {
				for (const next of edges.keys()) {
					if (
						next.startsWith(`${dependent.workId}\u0000${dependent.missionId}\u0000${dependent.executionId ?? ""}\u0000`)
					) {
						queue.push(next);
					}
				}
			}
		}
	}
	return ordered;
}

function buildSourceBases(
	projectPath: string,
	projectTrusted: boolean,
	initial: UpstreamExecutionBase,
	executions: ReadonlyMap<string, ExecutorRecord>,
): Map<string, UpstreamExecutionBase> {
	const bases = new Map<string, UpstreamExecutionBase>([[sourceKey(initial), initial]]);
	for (const execution of executions.values()) {
		if (execution.upstreamBase !== undefined) {
			bases.set(sourceKey(execution.upstreamBase), execution.upstreamBase);
		}
	}
	for (const record of listCoordinationRecords(projectPath, projectTrusted)) {
		if (
			record.relation === "dependency" &&
			record.upstreamWorkId !== undefined &&
			record.upstreamMissionId !== undefined &&
			record.upstreamExecutionId !== undefined &&
			record.upstreamHead !== undefined &&
			record.remote !== undefined &&
			record.branch !== undefined
		) {
			const base: UpstreamExecutionBase = {
				kind: "upstream-execution",
				workId: record.upstreamWorkId,
				missionId: record.upstreamMissionId,
				executionId: record.upstreamExecutionId,
				remote: record.remote,
				branch: record.branch,
				headCommit: record.upstreamHead,
			};
			bases.set(sourceKey(base), base);
		}
	}
	return bases;
}

function deterministicRevisionId(base: UpstreamExecutionBase, dependent: CoordinationDependent, kind: string): string {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				base,
				dependent: { workId: dependent.workId, missionId: dependent.missionId, executionId: dependent.executionId },
				kind,
			}),
		)
		.digest("hex");
	return `coordination-revision-${kind}-${digest}`;
}

function applyInvalidationHandling(
	projectPath: string,
	projectTrusted: boolean,
	dependent: CoordinationDependent,
	coordinationId: string,
	invalidationRecordId: string,
): UpstreamRevisionHandling {
	const execution =
		dependent.executionId === undefined
			? undefined
			: readExecutorRecord(projectPath, dependent.executionId, projectTrusted);
	if (execution === undefined) {
		return { ...dependent, coordinationId, invalidationRecordId, handling: "held" };
	}
	if (execution.status === ExecutorStatus.failed) {
		return { ...dependent, coordinationId, invalidationRecordId, handling: "same-mission-recovery-required" };
	}
	const signals = listSignalRecords(projectPath, projectTrusted).filter(
		(signal) =>
			signal.executionId === execution.executionId &&
			signal.missionId === execution.missionId &&
			signal.participantId === execution.participantId,
	);
	const blocked = signals.at(-1)?.kind === "blocked";
	if (execution.status === ExecutorStatus.running && blocked) {
		return { ...dependent, coordinationId, invalidationRecordId, handling: "retry-required" };
	}
	if (execution.status === ExecutorStatus.running) {
		updateExecutorRecord(projectPath, execution.executionId, { status: ExecutorStatus.failed }, projectTrusted);
		return { ...dependent, coordinationId, invalidationRecordId, handling: "same-mission-recovery-required" };
	}
	const reviewable = listPullRequestRecords(projectPath, projectTrusted).some(
		(pullRequest) => pullRequest.executionId === execution.executionId && pullRequest.status === "reviewable",
	);
	if (execution.status === ExecutorStatus.finished || reviewable) {
		const successor = materializeCoordinationSuccessor(
			projectPath,
			dependent.workId,
			dependent.missionId,
			coordinationId,
			projectTrusted,
		);
		return {
			...dependent,
			coordinationId,
			invalidationRecordId,
			handling: "successor-materialized",
			successorMissionId: successor.missionId,
		};
	}
	return { ...dependent, coordinationId, invalidationRecordId, handling: "same-mission-recovery-required" };
}

export type {
	CoordinationPhaseInput,
	PublishedHeadEvidence,
	TerminalResolutionEvidence,
	UpstreamRevisionInput,
	UpstreamRevisionResult,
};
export {
	directRevisionDependents,
	invalidateCoordination,
	materializeCoordinationSuccessor,
	orderCoordinationDependents,
	recordUpstreamRevision,
	releaseCoordination,
	resolveCoordination,
	resolveTerminalUpstreamCoordinations,
};
