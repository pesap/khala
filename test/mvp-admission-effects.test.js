import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { openSqlite } from "../dist/src/sqlite.js";
import { ZERO_USAGE, makeService, meta, admitAndStart } from "./helpers/mvp-fixtures.mjs";

test("Conclave can request missing intent and the User can amend terms before admission", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-input-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Input", objective: "Collect missing terms", acceptanceCriteria: ["The terms are complete"] },
		meta("user", "input:submit", 0),
	);
	assert.deepEqual(submitted.terms.validation, ["npm run check"]);
	const requested = await service.perform({
		action: "request-input",
		workId: submitted.workId,
		input: { reason: "Scope must identify the files to change", missing: ["scope", "allowedPaths"] },
		meta: meta("conclave", "input:request", submitted.revision, submitted.workId),
	});
	assert.equal(requested.value.state, "needs-input");
	const amended = await service.perform({
		action: "amend-terms",
		workId: submitted.workId,
		input: { scope: "Only the service implementation", validation: ["npm run check"], allowedPaths: ["src/service.ts"] },
		meta: meta("user", "input:amend", requested.value.revision),
	});
	assert.equal(amended.value.state, "submitted");
	assert.deepEqual(amended.value.terms.allowedPaths, ["src/service.ts"]);
	await service.close();
});

test("invalid Work submissions return a non-retryable input error", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-invalid-submit-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	assert.throws(
		() => service.submitWork({ title: " ", objective: "Objective", acceptanceCriteria: ["works"] }, meta("user", "invalid-submit", 0)),
		(error) => error instanceof Error && "envelope" in error && error.envelope.code === "invalid-input" && error.envelope.retryable === false,
	);
	await service.close();
});

test("Mission amendments create a successor without mutating the predecessor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-mission-amendment-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Mission", objective: "Amend the Mission", acceptanceCriteria: ["A successor exists"], scope: "Initial scope", validation: ["check"] },
		meta("user", "mission:submit", 0),
	);
	const admitted = await service.perform({ action: "admit", workId: submitted.workId, input: {}, meta: meta("conclave", "mission:admit", submitted.revision, submitted.workId) });
	assert.equal("error" in admitted, false, JSON.stringify(admitted));
	const predecessorId = admitted.value.mission.missionId;
	const amended = await service.perform({
		action: "amend-mission",
		workId: submitted.workId,
		input: { objective: "Use the successor scope", reason: "Repository evidence changed", evidence: ["architecture.md"] },
		meta: meta("conclave", "mission:amend", admitted.value.revision, submitted.workId),
	});
	assert.equal("error" in amended, false, JSON.stringify(amended));
	assert.equal(amended.value.mission.predecessorMissionId, predecessorId);
	assert.equal(amended.value.mission.assignment.objective, "Use the successor scope");
	assert.equal(amended.value.state, "queued");
	const changes = service.readRecords({ workId: submitted.workId, kinds: ["mission-change"] }, meta("user", "mission:records", amended.value.revision));
	assert.equal(changes.items.at(-1).payload.predecessorMissionId, predecessorId);
	await service.close();
});

test("Users can rename Work through an append-only action", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rename-work-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Original title", objective: "Verify renaming", acceptanceCriteria: ["The title changes"] },
		meta("user", "rename-work:submit", 0),
	);
	const admitted = await service.perform({
		action: "admit",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", "rename-work:admit", submitted.revision, submitted.workId),
	});
	assert.equal("error" in admitted, false);
	const action = service.availableActions(admitted.value.workId, "user", admitted.value.revision).find(
		(item) => item.kind === "rename-work",
	);
	assert.equal(action?.enabled, true);
	const renamed = await service.perform({
		action: "rename-work",
		workId: submitted.workId,
		input: { title: "khala-work" },
		meta: meta("user", "rename-work:apply", admitted.value.revision, submitted.workId),
	});
	assert.equal("error" in renamed, false);
	assert.equal(renamed.value.terms.title, "khala-work");
	assert.equal(renamed.value.mission.assignment.title, "Original title");
	assert.equal(renamed.value.mission.missionId, admitted.value.mission.missionId);
	assert.equal(renamed.value.revision, admitted.value.revision + 1);
	const amendedBudget = await service.perform({
		action: "amend-budget",
		workId: submitted.workId,
		input: { maxTokens: 200 },
		meta: meta("user", "rename-work:budget", renamed.value.revision, submitted.workId),
	});
	assert.equal("error" in amendedBudget, false);
	const duplicate = await service.perform({
		action: "rename-work",
		workId: submitted.workId,
		input: { title: "khala-work" },
		meta: meta("user", "rename-work:apply", admitted.value.revision, submitted.workId),
	});
	assert.equal("error" in duplicate, false);
	assert.equal(duplicate.value.revision, renamed.value.revision);
	assert.equal(duplicate.value.terms.title, renamed.value.terms.title);
	const conflicting = await service.perform({
		action: "amend-budget",
		workId: submitted.workId,
		input: { maxTokens: 300 },
		meta: meta("user", "rename-work:apply", amendedBudget.value.revision, submitted.workId),
	});
	assert.equal("error" in conflicting, true);
	assert.equal(conflicting.error.code, "invalid-input");
	const stale = await service.perform({
		action: "rename-work",
		workId: submitted.workId,
		input: { title: "another-title" },
		meta: meta("user", "rename-work:stale", admitted.value.revision, submitted.workId),
	});
	assert.equal("error" in stale, true);
	assert.equal(stale.error.code, "revision-conflict");
	const forbidden = await service.perform({
		action: "rename-work",
		workId: submitted.workId,
		input: { title: "conclave-title" },
		meta: meta("conclave", "rename-work:forbidden", amendedBudget.value.revision, submitted.workId),
	});
	assert.equal("error" in forbidden, true);
	assert.equal(forbidden.error.code, "forbidden");
	const records = service.readRecords(
		{ workId: submitted.workId, kinds: ["work-amended"] },
		meta("user", "rename-work:read", renamed.value.revision, submitted.workId),
	);
	assert.equal(records.items.length, 2);
	assert.deepEqual(records.items.find((record) => record.payload.change === "title")?.payload, {
		change: "title",
		previousTitle: "Original title",
		title: "khala-work",
	});
	await service.close();
});

test("A missing initialized Archive is not replaced with a new empty Archive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-missing-archive-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	archive.close();
	await rm(path);
	assert.throws(() => new SQLiteArchive(path), /refusing to create a replacement Archive/);
});

test("Archive migrates legacy failed and cancelled Work states", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-legacy-work-state-"));
	const path = join(directory, "archive.sqlite");
	const { service, archive } = makeService(path);
	const cancelled = service.submitWork(
		{ title: "Legacy Cancelled Work", objective: "Verify cancellation migration", acceptanceCriteria: ["The projection remains readable"] },
		meta("user", "legacy-state:cancelled", 0),
	);
	const failed = service.submitWork(
		{ title: "Legacy Failed Work", objective: "Verify failure migration", acceptanceCriteria: ["The projection remains readable"] },
		meta("user", "legacy-state:failed", 0),
	);
	archive.close();

	const database = openSqlite(path);
	for (const [workId, state] of [[cancelled.workId, "cancelled"], [failed.workId, "failed"]]) {
		const row = database.prepare("SELECT view_json FROM work_projection WHERE work_id = ?").get(workId);
		const view = JSON.parse(String(row.view_json));
		view.state = state;
		delete view.stopReason;
		database.prepare("UPDATE work_projection SET view_json = ? WHERE work_id = ?").run(JSON.stringify(view), workId);
		database.prepare("UPDATE archive_records SET state = ? WHERE work_id = ?").run(state, workId);
	}
	database.exec("DROP TABLE archive_record_numbers");
	database.close();

	const migrated = new SQLiteArchive(path);
	const cancelledProjection = migrated.project(cancelled.workId);
	assert.equal(cancelledProjection.state, "stopped");
	assert.equal(cancelledProjection.stopReason, "cancelled");
	const failedProjection = migrated.project(failed.workId);
	assert.equal(failedProjection.state, "stopped");
	assert.equal(failedProjection.stopReason, "failed");
	assert.equal(migrated.query({ states: ["stopped"] }).items.length, 2);
	assert.deepEqual(
		migrated.query().items.map(({ recordNumber, missionRecordNumber }) => ({ recordNumber, missionRecordNumber })),
		[
			{ recordNumber: 1, missionRecordNumber: undefined },
			{ recordNumber: 2, missionRecordNumber: undefined },
		],
	);
	migrated.close();
});

test("generated Mission and Execution IDs use Nano ID format", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-derived-id-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "derived-ids");
	assert.match(running.mission.missionId, /^[A-Za-z0-9_-]{21}$/);
	assert.match(running.execution.executionId, /^[A-Za-z0-9_-]{21}$/);
	await service.close();
});

test("Pending effect processing is serialized across callers and Works", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-effect-serialization-"));
	let activeWakes = 0;
	let maximumActiveWakes = 0;
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	controls.onConclaveWake = async () => {
		activeWakes += 1;
		maximumActiveWakes = Math.max(maximumActiveWakes, activeWakes);
		await new Promise((resolve) => setTimeout(resolve, 10));
		activeWakes -= 1;
	};
	service.submitWork({ title: "First", objective: "Queue one wake", acceptanceCriteria: ["It is processed"] }, meta("user", "effect-serialization:first", 0));
	service.submitWork({ title: "Second", objective: "Queue another wake", acceptanceCriteria: ["It is processed"] }, meta("user", "effect-serialization:second", 0));
	await Promise.all([service.processPendingEffects(), service.processPendingEffects()]);
	assert.equal(maximumActiveWakes, 1);
	await service.close();
});

test("Closing waits for an in-flight effect before closing its runtime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-effect-close-"));
	let releaseWake;
	let runtimeClosed = false;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send() {
					return new Promise((resolve) => {
						releaseWake = () => resolve({ output: "", usage: ZERO_USAGE });
					});
				},
				async close() {
					runtimeClosed = true;
				},
			},
		},
	});
	service.submitWork({ title: "Close", objective: "Wait for the effect", acceptanceCriteria: ["The runtime closes last"] }, meta("user", "effect-close:submit", 0));
	const processing = service.processPendingEffects();
	await new Promise((resolve) => setImmediate(resolve));
	const closing = service.close();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runtimeClosed, false);
	releaseWake();
	await Promise.all([processing, closing]);
	assert.equal(runtimeClosed, true);
});

test("Cleanup attention clears after a retry succeeds", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-cleanup-retry-"));
	let attempts = 0;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async removeSandbox() {
					attempts += 1;
					if (attempts === 1) throw new Error("sandbox is temporarily busy");
				},
			},
		},
	});
	const running = await admitAndStart(service, "cleanup-retry");
	const cancelled = await service.perform({
		action: "cancel",
		workId: running.workId,
		input: {},
		meta: meta("user", "cleanup-retry:cancel", running.revision, running.workId),
	});
	assert.equal("error" in cancelled, false);
	await service.processPendingEffects();
	const failedCleanup = service.inspectWork(running.workId);
	assert.match(failedCleanup.lastError?.summary ?? "", /Sandbox cleanup failed/);
	await service.processPendingEffects();
	const cleaned = service.inspectWork(running.workId);
	assert.equal(cleaned.lastError, undefined);
	assert.equal(cleaned.nextAction, "Work cancelled by the User.");
	await service.close();
});

test("Conclave wake failures preserve provider detail and remediation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-wake-failure-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send(binding) {
					if (binding.sessionId.startsWith("conclave-")) {
						throw new Error("OpenAI API error (429): quota exceeded");
					}
					return { output: "", usage: ZERO_USAGE };
				},
			},
		},
	});
	const submitted = service.submitWork(
		{ title: "Wake failure", objective: "Expose the cause", acceptanceCriteria: ["The error is actionable"] },
		meta("user", "wake-failure:submit", 0),
	);
	await service.processPendingEffects();
	const failed = service.inspectWork(submitted.workId);
	assert.equal(failed.lastError.summary, "Conclave admission failed: OpenAI API error (429): quota exceeded");
	assert.match(failed.lastError.remediation, /\/khala/);
	assert.equal(failed.nextAction, "Conclave decision failed; inspect Evidence and choose amendment, recovery, or failure.");
	const records = service.readRecords(
		{ workId: submitted.workId, kinds: ["error"] },
		meta("user", "wake-failure:read", failed.revision, submitted.workId),
	);
	assert.equal(records.items[0].payload.summary, failed.lastError.summary);
	await service.close();
});

test("uncertain Conclave failures retain their reservation without automatic retries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-wake-retry-"));
	let attempts = 0;
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async send(binding, message) {
					const isConclave = binding.sessionId.startsWith("conclave-");
					if (isConclave) {
						if (attempts++ === 0) throw new Error("Pi child exited before responding.");
						await controls.onConclaveWake?.(message);
					}
					return { output: "", usage: ZERO_USAGE };
				},
			},
		},
	});
	const submitted = service.submitWork(
		{ title: "Conclave wake retry", objective: "Retry transient startup loss", acceptanceCriteria: ["The wake is retried"] },
		meta("user", "conclave-wake-retry:submit", 0),
	);
	controls.onConclaveWake = async () => {
		const current = service.inspectWork(submitted.workId);
		if (current.state !== "submitted") return;
		const admitted = await service.perform({
			action: "admit",
			workId: submitted.workId,
			input: {},
			meta: meta("conclave", "conclave-wake-retry:admit", current.revision, submitted.workId),
		});
		assert.equal("error" in admitted, false);
	};
	await service.processPendingEffects();
	const current = service.inspectWork(submitted.workId);
	await service.processPendingEffects();
	await service.processPendingEffects();
	assert.equal(attempts, 1);
	assert.equal(controls.sessions.filter((entry) => entry.input.role === "conclave").length, 1);
	assert.equal(current.state, "submitted");
	assert.equal(current.activeInvocations[0].state, "uncertain");
	assert.equal(current.budget.reservedTokens, 50);
	assert.equal(
		service.readRecords({ workId: submitted.workId, kinds: ["error"] }, meta("user", "conclave-wake-retry:errors", current.revision)).items.length,
		1,
	);
	await service.close();
});

test("A Conclave wake remains retryable when the child records no decision", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-conclave-wake-no-decision-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "No decision", objective: "Keep the wake retryable", acceptanceCriteria: ["The pending wake remains visible"] },
		meta("user", "no-decision:submit", 0),
	);
	await service.processPendingEffects();
	const current = service.inspectWork(submitted.workId);
	assert.equal(current.state, "submitted");
	assert.match(current.lastError?.summary ?? "", /Conclave wake returned without recording a durable decision/);
	assert.equal(service.readRecords({ workId: submitted.workId, kinds: ["error"] }, meta("user", "no-decision:read", current.revision)).items.length, 1);
	assert.deepEqual(service.readRecords({ workId: submitted.workId }, meta("user", "no-decision:read-all", current.revision)).items.map((record) => record.kind), ["submission", "invocation", "invocation", "error"]);
	await service.close();
});

test("Recovered Work still requires an actual admission decision", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-recovered-admission-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	try {
		const submitted = service.submitWork(
			{ title: "Recovered admission", objective: "Require a durable admission decision", acceptanceCriteria: ["A no-op is not admission"] },
			meta("user", "recovered-admission:submit", 0),
		);
		const cancelled = await service.perform({ action: "cancel", workId: submitted.workId, input: {}, meta: meta("user", "recovered-admission:cancel", submitted.revision) });
		assert.equal("error" in cancelled, false);
		const recovered = await service.perform({ action: "recover", workId: submitted.workId, input: {}, meta: meta("user", "recovered-admission:recover", cancelled.value.revision) });
		assert.equal("error" in recovered, false);
		await service.processPendingEffects();
		const current = service.inspectWork(submitted.workId);
		assert.equal(current.state, "submitted");
		assert.match(current.lastError?.summary ?? "", /without recording a durable decision/);
	} finally {
		await service.close();
	}
});
