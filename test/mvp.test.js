import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeHostForOrigin } from "../dist/src/adapters.js";
import { SQLiteArchive } from "../dist/src/archive.js";
import { PiOracle } from "../dist/src/oracle.js";
import { ApplicationService } from "../dist/src/service.js";

function makePorts() {
	return {
		workspace: {
			async preflight() {
				return { projectPath: "/project", origin: "https://github.com/example/project", targetBranch: "main", headCommit: "base" };
			},
			async ensureSandbox(input) {
				return { path: `/tmp/${input.executionId}`, baseCommit: "base", branch: `khala/${input.workId}` };
			},
			async inspectHead() {
				return "head";
			},
		},
		codeHost: {
			async capabilities() {
				return { supportsDraft: true, supportsMergeObservation: true };
			},
			async identity() {
				return { principalId: "user-1", verified: true };
			},
			async ensureReviewRequest(input) {
				return {
					provider: "github",
					principalId: "user-1",
					providerId: "42",
					url: "https://github.com/example/project/pull/42",
					status: "draft",
					sourceBranch: input.sandbox.branch,
					targetBranch: input.targetBranch,
					headCommit: input.sandbox.baseCommit,
					diffSummary: "two files changed",
					validation: input.terms.validation,
				};
			},
			async poll() {
				return [];
			},
			async inspectOutcome() {
				return undefined;
			},
		},
		runtime: {
			async ensureSession() {
				return { sessionId: "session-1", sessionPath: "/tmp/session-1.jsonl" };
			},
			async send() {
				return "";
			},
			async getState() {
				return "idle";
			},
			async requestStop() {},
			async close() {},
		},
		models: {
			listScoped() {
				return ["provider/conclave", "provider/executor", "provider/oracle", "provider/observer"];
			},
			resolve(model) {
				return { model, supportedThinking: ["medium", "high"] };
			},
		},
		oracle: {
			async review() {
				return { verdict: "pass", findings: [], validationGaps: [], durationMs: 1, output: "Verdict: Pass" };
			},
		},
	};
}

function makeService(path) {
	return new ApplicationService(new SQLiteArchive(path), makePorts(), {
		projectPath: "/project",
		targetBranch: "main",
		maxConcurrentExecutions: 2,
		defaultWorkTokens: 100,
		conclaveModel: "provider/conclave",
		conclaveThinking: "medium",
		executorModel: "provider/executor",
		executorThinking: "high",
		oracleModel: "provider/oracle",
		oracleThinking: "high",
		conclavePromptIdentity: { packageVersion: "1.1.0", promptSha256: "conclave" },
		executorPromptIdentity: { packageVersion: "1.1.0", promptSha256: "executor" },
		observerPromptIdentity: { packageVersion: "1.1.0", promptSha256: "observer" },
	});
}

const userMeta = (commandId, expectedWorkRevision) => ({ actor: "user", commandId, expectedWorkRevision, schemaVersion: 1 });
const conclaveMeta = (commandId, expectedWorkRevision) => ({ actor: "conclave", commandId, expectedWorkRevision, schemaVersion: 1 });
const executorMeta = (commandId, expectedWorkRevision) => ({ actor: "executor", commandId, expectedWorkRevision, schemaVersion: 1 });
const monitorMeta = (commandId, expectedWorkRevision) => ({ actor: "monitor", commandId, expectedWorkRevision, schemaVersion: 1 });

test("Oracle preserves bounded findings and validation gaps", async () => {
	const oracle = new PiOracle(
		{
			async ensureSession() {
				return { sessionId: "oracle-session", sessionPath: "/tmp/oracle-session.jsonl" };
			},
			async send() {
				return "Verdict: Needs revision\n\nFindings:\n- [major] Missing test | Evidence: no test result\n\nValidation gaps:\n- integration test not run";
			},
			async getState() {
				return "idle";
			},
			async requestStop() {},
			async close() {},
		},
		"/project",
		"1.1.0",
		"oracle prompt",
	);
	const result = await oracle.review(
		{
			subject: "Review",
			mission: {
				missionId: "mission-1",
				workId: "work-1",
				assignment: {
					title: "Title",
					objective: "Objective",
					context: "",
					scope: "scope",
					acceptanceCriteria: ["accept"],
					constraints: [],
					validation: ["check"],
					maxTokens: 100,
				},
				mandateRevision: 1,
				createdAt: new Date().toISOString(),
			},
			diff: "diff",
			validation: ["check"],
			providerEvidence: [],
		},
		"provider/oracle",
		"high",
	);
	assert.equal(result.verdict, "needs-revision");
	assert.deepEqual(result.findings, [{ severity: "major", summary: "Missing test", evidence: ["no test result"] }]);
	assert.deepEqual(result.validationGaps, ["integration test not run"]);
});

test("Code-host detection accepts exact supported Git origins", () => {
	assert.equal(codeHostForOrigin("git@github.com:example/project.git", "/project").provider, "github");
	assert.equal(codeHostForOrigin("https://gitlab.com/example/project.git", "/project").provider, "gitlab");
	assert.throws(() => codeHostForOrigin("https://github.com.attacker.example/project.git", "/project"));
});

test("SQLite Archive preserves revisions, idempotency, and FIFO sequence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const projection = {
		workId: "w1",
		revision: 1,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
	};
	const input = { commandId: "command-1", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "w1", payloadVersion: 1, summary: "submitted", payload: projection.terms, projection };
	const first = archive.append(input);
	const duplicate = archive.append(input);
	assert.equal(first.duplicate, false);
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.record.sequence, first.record.sequence);
	assert.equal(archive.project("w1").queuedSequence, first.record.sequence);
	assert.equal(archive.pendingEffects().length, 0);
	archive.append({ ...input, commandId: "command-2", expectedWorkRevision: 1, projection: { ...projection, revision: 2, state: "queued" }, effects: [{ effectId: "effect-1", kind: "conclave-wake", payload: { workId: "w1" } }] });
	assert.equal(archive.pendingEffects()[0].effectId, "effect-1");
	archive.completeEffect("effect-1");
	assert.equal(archive.pendingEffects().length, 0);
	assert.throws(() => archive.append({ ...input, commandId: "command-1", workId: "w2" }), /already used for Work w1/);
	assert.throws(() => archive.append({ ...input, commandId: "command-3", expectedWorkRevision: 0 }));
	archive.close();
});

test("Application service runs the MVP handoff to provider-confirmed success", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-service-"));
	const service = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork({ title: "Feature", objective: "Implement feature", acceptanceCriteria: ["It works"] }, userMeta("submit", 0));
	assert.equal(submitted.state, "submitted");
	await service.processPendingEffects();
	assert.equal(service.submitWork({ title: "ignored", objective: "ignored", acceptanceCriteria: ["ignored"] }, userMeta("submit", 0)).workId, submitted.workId);
	const admitted = service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: conclaveMeta("admit", submitted.revision) });
	assert.equal((await admitted).value.state, "queued");
	assert.equal((await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: conclaveMeta("admit", submitted.revision) })).value.state, "queued");
	const queued = service.inspectWork(submitted.workId);
	const started = await service.perform({ action: "start-execution", workId: submitted.workId, input: {}, meta: conclaveMeta("start", queued.revision) });
	assert.equal("value" in started, true);
	const running = started.value;
	const review = await service.perform({ action: "create-review-request", workId: submitted.workId, input: {}, meta: executorMeta("review", running.revision) });
	const reviewReady = review.value;
	const signal = await service.perform({ action: "record-signal", workId: submitted.workId, input: { kind: "ready", summary: "Ready", evidence: ["diff", "validation"] }, meta: executorMeta("signal", reviewReady.revision) });
	const handoff = await service.perform({ action: "verdict", workId: submitted.workId, input: { decision: "handoff", reason: "Evidence is ready", signalId: signal.value.lastSignal.signalId }, meta: conclaveMeta("handoff", signal.value.revision) });
	assert.equal(handoff.value.state, "awaiting-review");
	const reviewed = await service.perform({ action: "record-review", workId: submitted.workId, input: { status: "merged", feedback: [] }, meta: userMeta("merged", handoff.value.revision) });
	const observed = service.recordObservation(submitted.workId, { observationId: "merge-1", kind: "provider-outcome", providerId: "42", status: "merged", summary: "Provider reports merged", changed: true, observedAt: new Date().toISOString() }, monitorMeta("observation", reviewed.value.revision));
	const outcome = await service.perform({ action: "record-outcome", workId: submitted.workId, input: {}, meta: conclaveMeta("outcome", observed.revision) });
	assert.equal(outcome.value.state, "succeeded");
	assert.equal(outcome.value.missionState, "succeeded");
	await service.close();
});
