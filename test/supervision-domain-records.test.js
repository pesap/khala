import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { appendArchiveRecord, listArchiveRecords, withArchiveLock } from "../dist/src/khala-archive.js";
import {
	listCoordinationRecords,
	projectActiveUpstreamBases,
	projectCoordinations,
	projectInterventions,
	projectMissions,
} from "../dist/src/khala-archive-projections.js";
import { loadKhalaConfig, resolveEffectiveWorkBudget } from "../dist/src/khala-config.js";
import {
	isCoordinationRecord,
	isInterventionRecord,
	isKhalaWork,
	isMandateRecord,
	isMissionRecord,
	isUpstreamExecutionBase,
	isV2ExecutorRecord,
} from "../dist/src/khala-model.js";
import { chooseNonInteractiveModels } from "../dist/src/khala-setup.js";
import {
	createExecutorRecord,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "../dist/src/khala-executor-registry.js";
import { startExecutor } from "../dist/src/khala-work-executor-runtime.js";

function supervisionConfig(overrides = {}) {
	return {
		conclaveModel: "provider/conclave",
		conclaveMaxCostUsdPerTurn: 0.25,
		executorModel: "provider/executor",
		executorMaxCostUsdPerTurn: 1,
		...overrides,
	};
}

function coordinationDecision() {
	return {
		coordinationId: "coordination-1",
		actionId: "coordination-action-1",
		phase: "decision",
		relation: "dependency",
		workId: "downstream-work",
		missionId: "downstream-mission",
		selectedWorkId: "upstream-work",
		selectedMissionId: "upstream-mission",
		relatedWorkId: "upstream-work",
		relatedMissionId: "upstream-mission",
		executionId: "downstream-execution",
		upstreamWorkId: "upstream-work",
		upstreamMissionId: "upstream-mission",
		upstreamExecutionId: "upstream-execution",
		relatedExecutionId: "upstream-execution",
		selectedExecutionId: "upstream-execution",
		remote: "origin",
		branch: "khala/upstream",
		reason: "The upstream contract must finish first.",
	};
}

function interventionIssuance() {
	return {
		interventionId: "intervention-1",
		actionId: "intervention-action-1",
		phase: "issuance",
		workId: "downstream-work",
		mandateId: "mandate-1",
		missionId: "downstream-mission",
		executionId: "execution-1",
		conclaveParticipantId: "conclave:test",
		executorParticipantId: "executor:execution-1",
		piSessionId: "pi-session-1",
		assessmentId: "assessment-1",
		failureSummary: "The Executor left the recorded scope.",
		category: "scope",
		missionTerm: "Scope",
		message: "Return to the immutable Mission scope.",
		promptIdentity: { packageVersion: "1.0.0", promptSha256: "a".repeat(64) },
		mode: "correction",
		piEntryIds: ["entry-1"],
		sentAt: new Date().toISOString(),
		transportResult: "confirmed",
	};
}

test("required supervision config inherits trusted project overrides without Pi fallback", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-config-"));
	const agentDir = join(root, "agent");
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(join(projectPath, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "khala.json"), JSON.stringify(supervisionConfig()));
		writeFileSync(
			join(projectPath, ".pi", "khala.json"),
			JSON.stringify({ executorModel: "provider/project-executor", executorMaxCostUsdPerTurn: 2 }),
		);
		const config = loadKhalaConfig(projectPath, true);
		assert.equal(config.conclaveModel, "provider/conclave");
		assert.equal(config.executorModel, "provider/project-executor");
		assert.equal(config.executorMaxCostUsdPerTurn, 2);
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent");
		assert.throws(() => loadKhalaConfig(undefined, false), /Rerun setup/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("effective Work budgets prefer typed Work overrides over merged configuration", () => {
	const config = supervisionConfig({ conclaveMaxCostUsdPerTurn: 0.25, executorMaxCostUsdPerTurn: 1 });
	assert.deepEqual(resolveEffectiveWorkBudget({ costBudget: { executorMaxCostUsdPerTurn: 3 } }, config), {
		conclaveMaxCostUsdPerTurn: 0.25,
		executorMaxCostUsdPerTurn: 3,
	});
	assert.deepEqual(resolveEffectiveWorkBudget({}, config), {
		conclaveMaxCostUsdPerTurn: 0.25,
		executorMaxCostUsdPerTurn: 1,
	});
});

test("non-interactive setup rejects an explicitly unavailable Executor model", () => {
	assert.throws(
		() =>
			chooseNonInteractiveModels(
				{ conclaveModel: "provider/available", executorModel: "provider/missing", oracleModel: "", observerModel: "" },
				["provider/available"],
			),
		/configured executorModel.*not discovered/i,
	);
	assert.throws(
		() => chooseNonInteractiveModels(
			{ conclaveModel: "", executorModel: "", oracleModel: "", observerModel: "" },
			["provider/discovered"],
		),
		/no model fallback is available/i,
	);
});

test("Work cost overrides survive guarded Submission, Mandate, and Mission records", () => {
	const budget = { conclaveMaxCostUsdPerTurn: 0.1, executorMaxCostUsdPerTurn: 0.8 };
	const work = {
		title: "Budgeted Work",
		objective: "Preserve the typed budget.",
		context: "Known context.",
		scope: "The slice.",
		acceptanceCriteria: ["The budget survives."],
		constraints: [],
		plan: ["Read the records."],
		validation: ["Run the focused test."],
		costBudget: budget,
	};
	const mandate = {
		mandateId: "mandate-1",
		workId: "work-1",
		revision: 1,
		sourceSubmissionRecordId: "submission-1",
		terms: work,
		admittedByParticipantId: "conclave:test",
		admittedAt: new Date().toISOString(),
	};
	const mission = {
		missionId: "mission-1",
		workId: "work-1",
		mandateId: "mandate-1",
		assignment: work,
		assignedParticipantId: "executor:mission-1",
		createdAt: new Date().toISOString(),
	};
	assert.equal(isKhalaWork(work), true);
	assert.equal(isMandateRecord(mandate), true);
	assert.equal(isMissionRecord(mission), true);
	assert.deepEqual(mission.assignment.costBudget, budget);
});

test("Executor launch uses immutable successor Mission terms and hashes only the system prompt", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-mission-prompt-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "khala.json"), JSON.stringify(supervisionConfig()));
	try {
		const executionId = "execution-prompt-1";
		const mission = {
			missionId: "successor-mission",
			workId: "work-1",
			mandateId: "mandate-1",
			assignment: {
				title: "Successor Mission",
				objective: "Use the successor assignment.",
				context: "Mission context",
				scope: "Successor scope",
				acceptanceCriteria: ["Successor acceptance"],
				constraints: ["Commit convention: mission-only"],
				plan: ["Use the successor plan"],
				validation: ["Run successor validation"],
			},
			assignedParticipantId: "executor:prompt-1",
			createdAt: new Date().toISOString(),
		};
		const starting = createExecutorRecord({
			executionId,
			workId: mission.workId,
			executorName: "Executor",
			kind: "executor",
			participantId: mission.assignedParticipantId,
			purpose: { kind: "mission", missionId: mission.missionId },
			missionId: mission.missionId,
			projectPath: root,
			sandboxPath: "",
			launcher: "pending",
		}, "starting");
		writeExecutorRecord(starting);
		let request;
		await startExecutor({
			context: { cwd: root },
			dependencies: {
				executorSystemPrompt: "ASSEMBLED SYSTEM PROMPT",
				createExecutorStarter: () => async (nextRequest) => {
					request = nextRequest;
					return { id: "launch", sandbox: { path: "/sandbox", name: "sandbox", projectPath: root } };
				},
			},
			projectTrusted: false,
			workId: mission.workId,
			submission: { workId: mission.workId, projectPath: root, status: "admitted", work: { ...mission.assignment, title: "Mutable submission" }, archivePath: "" },
			mandate: { mandateId: mission.mandateId, workId: mission.workId, revision: 1, sourceSubmissionRecordId: "submission", terms: mission.assignment, admittedByParticipantId: "conclave", admittedAt: new Date().toISOString() },
			learning: [],
			executionId,
			mission,
			participantId: mission.assignedParticipantId,
			executorName: "Executor",
			attemptNumber: 1,
		});
		assert.equal(request.name, "Successor Mission");
		assert.match(request.mission, /Successor Mission/);
		assert.doesNotMatch(request.mission, /Mutable submission/);
		assert.equal(request.reviewWorkflow.commitConvention, "mission-only");
		assert.equal(
			readExecutorRecord(root, executionId).promptIdentity.promptSha256,
			createHash("sha256").update("ASSEMBLED SYSTEM PROMPT").digest("hex"),
		);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("mission Executions require recoverable Pi identity and exact upstream bases", () => {
	const upstreamBase = {
		kind: "upstream-execution",
		workId: "upstream-work",
		missionId: "upstream-mission",
		executionId: "upstream-execution",
		remote: "origin",
		branch: "khala/upstream",
		headCommit: "a".repeat(40),
	};
	const execution = {
		executionId: "execution-1",
		workId: "downstream-work",
		executorName: "Executor",
		kind: "executor",
		participantId: "executor:execution-1",
		purpose: { kind: "mission", missionId: "downstream-mission" },
		missionId: "downstream-mission",
		projectPath: "/project",
		sandboxPath: "/sandbox",
		launcher: "headless",
		piSessionId: "pi-session-1",
		sessionPath: "/sessions/pi-session-1.jsonl",
		promptIdentity: { packageVersion: "1.0.0", promptSha256: "b".repeat(64) },
		upstreamBase,
		status: "running",
		startedAt: new Date().toISOString(),
	};
	assert.equal(isUpstreamExecutionBase(upstreamBase), true);
	assert.equal(isV2ExecutorRecord(execution), true);
	assert.equal(isV2ExecutorRecord({ ...execution, sessionPath: undefined }), false);
	assert.equal(
		isMissionRecord({
			missionId: "successor",
			workId: "work",
			mandateId: "mandate",
			predecessorMissionId: "predecessor",
			causedByVerdictId: "verdict",
			causedByCoordinationId: "coordination",
			assignment: { title: "T", objective: "O", context: "C", scope: "S", acceptanceCriteria: ["A"], constraints: [], plan: ["P"], validation: ["V"] },
			assignedParticipantId: "executor:successor",
			createdAt: new Date().toISOString(),
		}),
		false,
	);
});

test("Executor identity bindings survive updates and reject omission, clearing, and replacement", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-bindings-"));
	try {
		const execution = createExecutorRecord({
			executionId: "binding-execution",
			workId: "binding-work",
			executorName: "Executor",
			kind: "executor",
			participantId: "executor:binding",
			purpose: { kind: "mission", missionId: "binding-mission" },
			missionId: "binding-mission",
			projectPath: root,
			sandboxPath: "/sandbox",
			launcher: "headless",
			piSessionId: "session-1",
			sessionPath: "/session-1.jsonl",
			promptIdentity: { packageVersion: "1.0.0", promptSha256: "c".repeat(64) },
			status: "running",
		});
		writeExecutorRecord(execution);
		assert.throws(() => writeExecutorRecord({ ...execution, piSessionId: undefined }), /immutable Pi session ID/);
		assert.throws(() => writeExecutorRecord({ ...execution, sessionPath: "/replacement.jsonl" }), /immutable Pi session path/);
		assert.throws(() => updateExecutorRecord(root, execution.executionId, { piSessionId: "session-2" }), /immutable identity/);
		assert.throws(() => updateExecutorRecord(root, execution.executionId, { piSessionId: undefined }), /immutable/);
		const updated = updateExecutorRecord(root, execution.executionId, { status: "finished" });
		assert.equal(updated.piSessionId, "session-1");
		assert.equal(updated.sessionPath, "/session-1.jsonl");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("supervision Archive replay is idempotent, causal, and projected fail-closed", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-archive-"));
	const projectPath = join(root, "project");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "khala.json"), JSON.stringify(supervisionConfig()));
	try {
		const decision = coordinationDecision();
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: decision.workId, payload: decision });
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: decision.workId, payload: decision });
		assert.equal(listCoordinationRecords(projectPath).length, 1);
		assert.equal(projectCoordinations(projectPath)[0].active, true);
		assert.throws(
			() => appendArchiveRecord(projectPath, {
				schemaVersion: 2,
				type: "coordination",
				workId: decision.workId,
				payload: { ...decision, reason: "Conflicting replay." },
			}),
			/different evidence/,
		);
		assert.throws(
			() => appendArchiveRecord(projectPath, {
				schemaVersion: 2,
				type: "coordination",
				workId: decision.workId,
				executionId: "wrong-execution",
				payload: decision,
			}),
			/different evidence|inconsistent Archive bindings/,
		);
		const invalidation = {
			...decision,
			actionId: "coordination-action-2",
			phase: "invalidation",
			upstreamHead: "a".repeat(40),
			replacementHead: null,
			affectedDependents: [{ workId: decision.workId, missionId: decision.missionId, executionId: decision.executionId, supersededHead: "a".repeat(40) }],
			remoteObservation: { remote: "origin", branch: decision.branch, headCommit: null, observedAt: new Date().toISOString() },
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: decision.workId, payload: invalidation });
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "coordination",
					workId: decision.workId,
					payload: { ...invalidation, actionId: "coordination-action-bad-head", replacementHead: "d".repeat(40) },
				}),
			/invalid .*Archive record/,
		);
		const repeatedInvalidation = {
			...invalidation,
			actionId: "coordination-action-3",
			upstreamHead: "b".repeat(40),
			replacementHead: "c".repeat(40),
			affectedDependents: [{ workId: decision.workId, missionId: decision.missionId, executionId: decision.executionId, supersededHead: "b".repeat(40) }],
			remoteObservation: { remote: "origin", branch: decision.branch, headCommit: "c".repeat(40), observedAt: new Date().toISOString() },
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: decision.workId, payload: repeatedInvalidation });
		const transitiveDecision = {
			...decision,
			coordinationId: "transitive-coordination",
			actionId: "transitive-decision",
			workId: "transitive-work",
			missionId: "transitive-mission",
			executionId: "transitive-execution",
			selectedWorkId: decision.workId,
			selectedMissionId: decision.missionId,
			selectedExecutionId: decision.executionId,
			relatedWorkId: decision.workId,
			relatedMissionId: decision.missionId,
			relatedExecutionId: decision.executionId,
			upstreamWorkId: decision.workId,
			upstreamMissionId: decision.missionId,
			upstreamExecutionId: decision.executionId,
		};
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "coordination",
			workId: transitiveDecision.workId,
			payload: transitiveDecision,
		});
		const transitiveInvalidation = {
			...transitiveDecision,
			actionId: "transitive-invalidation",
			phase: "invalidation",
			upstreamHead: "c".repeat(40),
			affectedDependents: [
				{ workId: decision.workId, missionId: decision.missionId, supersededHead: "c".repeat(40) },
			],
			causedByCoordinationId: decision.coordinationId,
		};
		appendArchiveRecord(projectPath, {
			schemaVersion: 2,
			type: "coordination",
			workId: transitiveInvalidation.workId,
			payload: transitiveInvalidation,
		});
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "coordination",
					workId: transitiveInvalidation.workId,
					payload: {
						...transitiveInvalidation,
						coordinationId: "unrelated-transitive",
						actionId: "unrelated-transitive-invalidation",
						causedByCoordinationId: "missing-parent",
					},
				}),
			/unrelated transitive invalidation cause/,
		);
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "coordination",
					workId: transitiveInvalidation.workId,
					payload: {
						...transitiveInvalidation,
						actionId: "transitive-invalid-null",
						replacementHead: null,
					},
				}),
			/invalid .*Archive record/,
		);
		assert.throws(
			() =>
				appendArchiveRecord(projectPath, {
					schemaVersion: 2,
					type: "coordination",
					workId: decision.workId,
					payload: { ...invalidation, actionId: "coordination-action-bad-null", replacementHead: null, remoteObservation: { ...invalidation.remoteObservation, headCommit: "e".repeat(40) } },
				}),
			/invalid .*Archive record/,
		);
		const predecessor = {
			missionId: decision.missionId,
			workId: decision.workId,
			mandateId: "mandate-downstream",
			assignment: { title: "Downstream", objective: "Wait", context: "Known", scope: "Slice", acceptanceCriteria: ["Wait"], constraints: [], plan: ["Wait"], validation: ["Read"] },
			assignedParticipantId: "executor:old",
			createdAt: new Date().toISOString(),
		};
		const successor = {
			...predecessor,
			missionId: "downstream-mission-2",
			predecessorMissionId: predecessor.missionId,
			causedByCoordinationId: decision.coordinationId,
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mission", workId: predecessor.workId, payload: predecessor });
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "mission", workId: successor.workId, payload: successor });
		assert.equal(projectMissions(projectPath)[1].mission.causedByCoordinationId, decision.coordinationId);

		const peerDecision = {
			...decision,
			coordinationId: "peer-coordination",
			actionId: "peer-action-1",
			relation: "peer-conflict",
			workId: "peer-waiting",
			missionId: "peer-waiting-mission",
			selectedWorkId: "peer-priority",
			selectedMissionId: "peer-priority-mission",
			relatedWorkId: "peer-priority",
			relatedMissionId: "peer-priority-mission",
			upstreamWorkId: undefined,
			upstreamMissionId: undefined,
			remote: undefined,
			branch: undefined,
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: peerDecision.workId, payload: peerDecision });
		const peerOverride = { ...peerDecision, phase: "override", actionId: "peer-action-2", selectedWorkId: peerDecision.workId, selectedMissionId: peerDecision.missionId, userEntryId: "user-entry" };
		assert.equal(isCoordinationRecord(peerOverride), true);
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: peerOverride.workId, payload: peerOverride });
		assert.throws(
			() => appendArchiveRecord(projectPath, { schemaVersion: 2, type: "coordination", workId: peerOverride.workId, payload: { ...peerOverride, actionId: "peer-action-3", relatedWorkId: "third-work", relatedMissionId: "third-mission", selectedWorkId: "third-work", selectedMissionId: "third-mission" } }),
			/changed its identity/,
		);
		const issuance = interventionIssuance();
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "intervention", workId: issuance.workId, executionId: issuance.executionId, payload: issuance });
		assert.equal(projectInterventions(projectPath)[0].outstanding, true);
		const mismatchedOutcome = {
			...issuance,
			phase: "outcome",
			actionId: "intervention-action-mismatch",
			mandateId: "different-mandate",
			outcome: "resolved",
			observedEntryIds: ["entry-2"],
			reason: "The next turn returned to scope.",
		};
		assert.throws(
			() => appendArchiveRecord(projectPath, { schemaVersion: 2, type: "intervention", workId: issuance.workId, executionId: issuance.executionId, payload: mismatchedOutcome }),
			/changed its identity/,
		);
		const outcome = {
			...issuance,
			phase: "outcome",
			actionId: "intervention-action-2",
			outcome: "resolved",
			observedEntryIds: ["entry-2"],
			reason: "The next turn returned to scope.",
		};
		appendArchiveRecord(projectPath, { schemaVersion: 2, type: "intervention", workId: issuance.workId, executionId: issuance.executionId, payload: outcome });
		assert.equal(projectInterventions(projectPath)[0].outstanding, false);
		assert.equal(isInterventionRecord(issuance), true);
		assert.throws(
			() => appendArchiveRecord(projectPath, { schemaVersion: 2, type: "intervention", workId: issuance.workId, executionId: issuance.executionId, payload: { ...outcome, actionId: "intervention-action-3" } }),
			/invalid outcome order/,
		);
		assert.equal(listArchiveRecords(projectPath).length, 11);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Archive append and read remain re-entrant inside an existing Archive lock", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-lock-"));
	try {
		const record = interventionIssuance();
		const records = withArchiveLock(root, false, () => {
			appendArchiveRecord(root, { schemaVersion: 2, type: "intervention", workId: record.workId, executionId: record.executionId, payload: record });
			return listArchiveRecords(root);
		});
		assert.equal(records.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("active upstream base projection excludes verified-merged bindings", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-supervision-domain-active-base-"));
	try {
		const assignment = { title: "Dependent", objective: "Use a base", context: "Context", scope: "Scope", acceptanceCriteria: ["Accept"], constraints: [], plan: ["Plan"], validation: ["Validate"] };
		appendArchiveRecord(root, { schemaVersion: 2, type: "mission", workId: "dependent-work", payload: { missionId: "dependent-mission", workId: "dependent-work", mandateId: "mandate", assignment, assignedParticipantId: "executor:dependent", createdAt: new Date().toISOString() } });
		const base = { kind: "upstream-execution", workId: "upstream-work", missionId: "upstream-mission", executionId: "upstream-execution", remote: "origin", branch: "khala/upstream", headCommit: "a".repeat(40) };
		appendArchiveRecord(root, { schemaVersion: 2, type: "execution", workId: "dependent-work", executionId: "dependent-execution", payload: { executionId: "dependent-execution", workId: "dependent-work", executorName: "Dependent", kind: "executor", participantId: "executor:dependent", purpose: { kind: "mission", missionId: "dependent-mission" }, missionId: "dependent-mission", projectPath: root, sandboxPath: "/sandbox", launcher: "headless", piSessionId: "session", sessionPath: "/session", promptIdentity: { packageVersion: "1", promptSha256: "d".repeat(64) }, upstreamBase: base, status: "running", startedAt: new Date().toISOString() } });
		assert.deepEqual(projectActiveUpstreamBases(root), [base]);
		appendArchiveRecord(root, { schemaVersion: 2, type: "pull-request", workId: base.workId, executionId: base.executionId, payload: { pullRequestId: "pr-upstream", workId: base.workId, missionId: base.missionId, executionId: base.executionId, status: "merged", headCommit: base.headCommit, mergeCommit: "b".repeat(40), changedFiles: [], diffSummary: "Merged", validationResults: [], reviewFeedback: [], unresolvedGaps: [], recordedAt: new Date().toISOString() } });
		assert.deepEqual(projectActiveUpstreamBases(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
