import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeHostForOrigin, CommandCodeHost, readPullRequestTemplate } from "../dist/src/adapters.js";
import { SQLiteArchive } from "../dist/src/archive.js";
import { openSqlite } from "../dist/src/sqlite.js";
import { PiOracle } from "../dist/src/oracle.js";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { createRuntimeStorage } from "../dist/src/runtime-storage.js";
import { authority, ZERO_USAGE, makeService, meta, admitAndStart, restorePath } from "./helpers/mvp-fixtures.mjs";

test("a released project slot wakes the FIFO queued Mission", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-queue-wake-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { maxConcurrentExecutions: 1 });
	const firstSubmitted = service.submitWork(
		{ title: "First", objective: "Use the first slot", acceptanceCriteria: ["It starts"] },
		meta("user", "queue-wake:first-submit", 0),
	);
	const firstAdmitted = await service.perform({
		action: "admit",
		workId: firstSubmitted.workId,
		input: {},
		meta: meta("conclave", "queue-wake:first-admit", firstSubmitted.revision, firstSubmitted.workId),
	});
	const firstQueued = await service.perform({
		action: "start-execution",
		workId: firstSubmitted.workId,
		input: {},
		meta: meta("conclave", "queue-wake:first-start", firstAdmitted.value.revision, firstSubmitted.workId),
	});
	assert.equal(firstQueued.value.execution.state, "queued");
	await service.processPendingEffects();
	await new Promise((resolve) => setImmediate(resolve));

	const secondSubmitted = service.submitWork(
		{ title: "Second", objective: "Wait for the first slot", acceptanceCriteria: ["It starts after the first Work ends"] },
		meta("user", "queue-wake:second-submit", 0),
	);
	const secondAdmitted = await service.perform({
		action: "admit",
		workId: secondSubmitted.workId,
		input: {},
		meta: meta("conclave", "queue-wake:second-admit", secondSubmitted.revision, secondSubmitted.workId),
	});
	assert.equal(secondAdmitted.value.state, "queued");
	await service.processPendingEffects();
	const promptsBeforeRelease = controls.prompts.filter((prompt) => prompt.message.includes(secondSubmitted.workId)).length;
	const secondStart = await service.perform({
		action: "start-execution",
		workId: secondSubmitted.workId,
		input: {},
		meta: meta("conclave", "queue-wake:second-start", service.inspectWork(secondSubmitted.workId).revision, secondSubmitted.workId),
	});
	assert.equal(secondStart.value.execution, undefined);

	const firstCurrent = service.inspectWork(firstSubmitted.workId);
	const failed = await service.perform({
		action: "fail-work",
		workId: firstSubmitted.workId,
		input: { reason: "Release the slot for the FIFO queue." },
		meta: meta("user", "queue-wake:first-fail", firstCurrent.revision, firstSubmitted.workId),
	});
	assert.equal(failed.value.state, "stopped");
	assert.equal(failed.value.stopReason, "failed");
	await service.processPendingEffects();
	const promptsAfterRelease = controls.prompts.filter((prompt) => prompt.message.includes(secondSubmitted.workId)).length;
	assert.ok(promptsAfterRelease > promptsBeforeRelease);
	await service.close();
});

test("project concurrency reserves a slot before runtime launch and reports external failures distinctly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-concurrency-"));
	const path = join(directory, "archive.sqlite");
	const first = makeService(path, { maxConcurrentExecutions: 1 });
	const firstSubmitted = first.service.submitWork({ title: "First", objective: "Use the first slot", acceptanceCriteria: ["It starts"] }, meta("user", "slots:first-submit", 0));
	const firstAdmitted = await first.service.perform({ action: "admit", workId: firstSubmitted.workId, input: {}, meta: meta("conclave", "slots:first-admit", firstSubmitted.revision, firstSubmitted.workId) });
	const firstQueued = await first.service.perform({ action: "start-execution", workId: firstSubmitted.workId, input: {}, meta: meta("conclave", "slots:first-start", firstAdmitted.value.revision, firstSubmitted.workId) });
	assert.equal(firstQueued.value.execution.state, "queued");
	const secondSubmitted = first.service.submitWork({ title: "Second", objective: "Wait for the slot", acceptanceCriteria: ["It waits"] }, meta("user", "slots:second-submit", 0));
	const secondAdmitted = await first.service.perform({ action: "admit", workId: secondSubmitted.workId, input: {}, meta: meta("conclave", "slots:second-admit", secondSubmitted.revision, secondSubmitted.workId) });
	const secondStart = await first.service.perform({ action: "start-execution", workId: secondSubmitted.workId, input: {}, meta: meta("conclave", "slots:second-start", secondAdmitted.value.revision, secondSubmitted.workId) });
	assert.equal(secondStart.value.execution, undefined);
	await first.service.close();

	const failure = makeService(join(directory, "failure.sqlite"), { ports: { workspace: { async publishSandbox() { throw new Error("push failed"); } } } });
	const running = await admitAndStart(failure.service, "external");
	const result = await failure.service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "external:review", running.revision, running.workId, running.execution.executionId) });
	assert.equal(result.error.code, "external-failure");
	assert.equal(result.error.retryable, true);
	await failure.service.close();
});

test("Executor authority is bound to the current Work and ready evidence rejects a stale head", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-authority-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "authority");
	const denied = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "progress", summary: "Progress", evidence: ["file"] }, meta: meta("user", "authority:user-signal", running.revision, running.workId) });
	assert.equal(denied.error.code, "forbidden");
	assert.match(denied.error.remediation, /Executor Signals and review requests/);
	const wrongScope = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "progress", summary: "Progress", evidence: ["file"] }, meta: meta("executor", "authority:wrong-work", running.revision, "other-work", running.execution.executionId) });
	assert.equal(wrongScope.error.code, "forbidden");
	const scopedRecords = service.readRecords(
		{ workId: running.workId },
		meta("executor", "authority:scoped-read", 0, running.workId, running.execution.executionId),
	);
	assert.equal(scopedRecords.items.every((record) => record.executionId === undefined || record.executionId === running.execution.executionId), true);
	const mismatchedRead = { ...meta("conclave", "authority:mismatched-read", 0, running.workId), actor: "executor" };
	assert.throws(() => service.readRecords({ workId: running.workId }, mismatchedRead), /does not match/);
	const other = service.submitWork({ title: "Other", objective: "Other Work", acceptanceCriteria: ["It remains separate"] }, meta("user", "authority:other-submit", 0));
	const wrongConclave = await service.perform({ action: "admit", workId: other.workId, input: {}, meta: meta("conclave", "authority:wrong-conclave", other.revision, running.workId) });
	assert.equal(wrongConclave.error.code, "forbidden");
	const review = await service.perform({ action: "create-review-request", workId: running.workId, input: {}, meta: meta("executor", "authority:review", running.revision, running.workId, running.execution.executionId) });
	controls.head = "changed-after-publication";
	const stale = await service.perform({ action: "record-signal", workId: running.workId, input: { kind: "ready", summary: "Ready", evidence: ["head", "diff"] }, meta: meta("executor", "authority:stale", review.value.revision, running.workId, running.execution.executionId) });
	assert.equal(stale.error.code, "invalid-state");
	controls.outcomeObservation = { observationId: "bad", kind: "provider-outcome", providerId: "42", status: "observed", summary: "Not a merge", changed: true, observedAt: new Date().toISOString() };
	await assert.rejects(
		service.pollProvider(running.workId, meta("user", "authority:bad-observation", review.value.revision)),
		/merged reviewed/,
	);
	await service.close();
});

test("Archive repairs missing record numbers without changing existing assignments", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-number-repair-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	const projection = {
		workId: "w1",
		revision: 1,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
	};
	const first = archive.append({ commandId: "repair-command-1", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "w1", payloadVersion: 1, summary: "submitted", payload: projection.terms, projection });
	const second = archive.append({ ...firstInput(first, projection), commandId: "repair-command-2", expectedWorkRevision: 1, missionId: "mission-1", projection: { ...projection, revision: 2, state: "queued" } });
	const third = archive.append({ ...firstInput(first, projection), commandId: "repair-command-3", expectedWorkRevision: 2, missionId: "mission-1", projection: { ...projection, revision: 3, state: "active" } });
	archive.close();

	const database = openSqlite(path);
	database.prepare("DELETE FROM archive_record_numbers WHERE record_id = ?").run(second.record.id);
	database.close();

	const migrated = new SQLiteArchive(path);
	assert.deepEqual(
		migrated.query().items.map(({ sequence, recordNumber, missionRecordNumber }) => ({ sequence, recordNumber, missionRecordNumber })),
		[
			{ sequence: first.record.sequence, recordNumber: 1, missionRecordNumber: undefined },
			{ sequence: second.record.sequence, recordNumber: 2, missionRecordNumber: 1 },
			{ sequence: third.record.sequence, recordNumber: 3, missionRecordNumber: 2 },
		],
	);
	migrated.close();
});

function firstInput(first, projection) {
	return { commandId: first.record.commandId, expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "w1", payloadVersion: 1, summary: "submitted", payload: projection.terms, projection };
}

test("Archive appends validate projections and claim each external effect once", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-archive-"));
	const archive = new SQLiteArchive(join(directory, "archive.sqlite"));
	const projection = {
		workId: "w1",
		revision: 1,
		state: "submitted",
		terms: { title: "Title", objective: "Objective", context: "", scope: "scope", acceptanceCriteria: ["accept"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 },
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "pending",
		queuedSequence: 0,
	};
	const input = { commandId: "command-1", expectedWorkRevision: 0, kind: "submission", actor: "user", workId: "w1", payloadVersion: 1, summary: "submitted", payload: projection.terms, projection };
	const first = archive.append(input);
	const duplicate = archive.append(input);
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.record.sequence, first.record.sequence);
	assert.equal(first.record.recordNumber, 1);
	assert.equal(first.record.missionRecordNumber, undefined);
	assert.match(first.record.id, /^[A-Za-z0-9_-]{21}$/);
	assert.equal(archive.project("w1").queuedSequence, first.record.sequence);
	assert.equal(archive.query({ states: ["submitted"] }).items.length, 1);
	assert.throws(() => archive.append({ ...input, workId: "w2" }), /already used for Work w1/);
	const second = archive.append({
		...input,
		commandId: "command-2",
		expectedWorkRevision: 1,
		missionId: "mission-1",
		projection: { ...projection, revision: 2, state: "queued" },
	});
	const third = archive.append({
		...input,
		commandId: "command-3",
		expectedWorkRevision: 2,
		missionId: "mission-1",
		projection: { ...projection, revision: 3, state: "active" },
		effects: [{ effectId: "effect-1", kind: "conclave-wake", payload: { workId: "w1" } }],
	});
	const fourth = archive.append({
		...input,
		commandId: "command-4",
		expectedWorkRevision: 3,
		missionId: "mission-2",
		projection: { ...projection, revision: 4, state: "active" },
		effects: [{ effectId: "effect-1", kind: "conclave-wake", payload: { workId: "w1" } }],
	});
	assert.deepEqual(
		[second.record, third.record, fourth.record].map(({ sequence, recordNumber, missionRecordNumber }) => ({ sequence, recordNumber, missionRecordNumber })),
		[
			{ sequence: 2, recordNumber: 2, missionRecordNumber: 1 },
			{ sequence: 3, recordNumber: 3, missionRecordNumber: 2 },
			{ sequence: 4, recordNumber: 4, missionRecordNumber: 1 },
		],
	);
	assert.equal(archive.query({ missionId: "mission-1" }).items[0]?.missionRecordNumber, 1);
	assert.equal(archive.query({ missionId: "mission-1" }).items[1]?.missionRecordNumber, 2);
	const database = openSqlite(join(directory, "archive.sqlite"));
	assert.deepEqual(
		database
			.prepare("SELECT record_number, mission_id, mission_record_number FROM archive_record_numbers ORDER BY record_number")
			.all()
			.map((row) => [row.record_number, row.mission_id, row.mission_record_number]),
		[
			[1, null, null],
			[2, "mission-1", 1],
			[3, "mission-1", 2],
			[4, "mission-2", 1],
		],
	);
	database.close();
	assert.equal(archive.pendingEffects("owner-a").length, 1);
	assert.throws(
		() => archive.append({ ...input, commandId: "command-5", expectedWorkRevision: 4, projection: { ...projection, revision: 5, state: "active" }, effects: [{ effectId: "effect-1", kind: "scheduler-wake", payload: { workId: "w1" } }] }),
		/conflicts with an existing effect/,
	);
	assert.equal(archive.pendingEffects("owner-b").length, 0);
	archive.completeEffect("effect-1", "owner-a");
	assert.equal(archive.pendingEffects("owner-b").length, 0);
	archive.close();

	const reopened = new SQLiteArchive(join(directory, "archive.sqlite"));
	assert.equal(reopened.query().items[0]?.id, first.record.id);
	reopened.close();
});

test("a real RPC startup retries one transient child exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-startup-retry-"));
	const marker = join(directory, "launch-count");
	const script = join(directory, "rpc-startup-retry.mjs");
	await writeFile(
		script,
		`import { readFileSync, writeFileSync } from "node:fs";\nimport readline from "node:readline";\nif (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }\nconst marker = ${JSON.stringify(marker)};\nconst launches = Number(readFileSync(marker, "utf8")) + 1;\nwriteFileSync(marker, String(launches));\nif (launches === 1) process.exit(1);\nconst sessionPath = process.argv[process.argv.indexOf("--session") + 1];\nconst input = readline.createInterface({ input: process.stdin });\ninput.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); });\n`,
	);
	await writeFile(marker, "0");
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000, agentTimeoutMs: 100 });
	const binding = await runtime.ensureSession({
		cwd: directory,
		model: "model",
		thinking: "medium",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "hash" },
		tools: [],
	});
	assert.equal(binding.sessionId, "stub-session");
	assert.equal((await readFile(marker, "utf8")).trim(), "2");
	await runtime.close();
});

test("Persistent runtime sessions have one owner and private transcripts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-ownership-"));
	const script = join(directory, "rpc-stub.mjs");
	const storage = createRuntimeStorage(directory);
	const sessionPath = storage.persistentSessionPath("executor", "ownership");
	await mkdir(join(storage.root, "sessions"), { recursive: true });
	await writeFile(sessionPath, "transcript", { mode: 0o644 });
	await writeFile(script, `import { statSync } from "node:fs"; import readline from "node:readline"; if (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); } const sessionPath = ${JSON.stringify(sessionPath)}; const input = readline.createInterface({ input: process.stdin }); input.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") { if ((statSync(sessionPath).mode & 0o777) !== 0o600 || (statSync(process.env.KHALA_ROLE_TOKEN_FILE).mode & 0o777) !== 0o600) process.exit(2); process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); } });\n`);
	await chmod(script, 0o755);
	const options = { projectPath: directory, command: [process.execPath, script], authorityPrivateKey: authority.privateKey, rpcTimeoutMs: 1_000, agentTimeoutMs: 500 };
	const first = new PiRpcRuntime(options);
	const input = { cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: ["read"], sessionPath };
	await first.ensureSession(input);
	assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
	const second = new PiRpcRuntime(options);
	await assert.rejects(second.ensureSession(input), /already owned/);
	await first.close();
	await second.close();
});

test("Runtime storage canonicalizes projects and rejects symlinked paths", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-storage-"));
	const alias = join(directory, "alias");
	const outside = join(directory, "outside");
	await mkdir(outside);
	await symlink(directory, alias, "dir");
	const direct = createRuntimeStorage(directory);
	const linked = createRuntimeStorage(alias);
	const nanoId = "[A-Za-z0-9_-]{21}";
	assert.match(direct.ephemeralSessionPath(), new RegExp(`khala-ephemeral-${nanoId}\\.jsonl$`));
	assert.match(direct.capabilityFilePath(), new RegExp(`khala-capability-${nanoId}$`));
	assert.match(direct.launchTemporaryPath(direct.persistentSessionPath("executor", "artifacts")), new RegExp(`\\.${nanoId}\\.tmp$`));
	await Promise.all(Array.from({ length: 8 }, () => direct.prepare()));
	assert.equal(direct.root, linked.root);
	assert.equal(direct.persistentSessionPath("executor", "same"), linked.persistentSessionPath("executor", "same"));
	await direct.prepare();
	await rm(join(direct.root, "sessions"), { recursive: true });
	await symlink(outside, join(direct.root, "sessions"), "dir");
	assert.throws(() => direct.ephemeralSessionPath(), /symlinks/);
	await rm(join(direct.root, "sessions"), { recursive: true });
	await mkdir(join(direct.root, "sessions"));
	await symlink(outside, join(direct.root, "sessions", "nested"), "dir");
	assert.throws(
		() => direct.ownedPath(`${direct.root}/sessions/nested/../victim`),
		/symlinks/,
	);
	await rm(direct.root, { recursive: true, force: true });
});

test("a real RPC child is bounded and removed after an agent turn timeout", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `import readline from "node:readline";\nif (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }\nconst sessionPath = process.argv[process.argv.indexOf("--session") + 1];\nconst input = readline.createInterface({ input: process.stdin });\ninput.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); else if (request.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n"); });\n`);
	await chmod(script, 0o755);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000, agentTimeoutMs: 30 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	await assert.rejects(runtime.send(binding, "never completes", { tokenAllowance: 100 }), /timed out/);
	assert.equal(await runtime.getState(binding), "unreachable");
	await runtime.close();
});

test("a real RPC child waits for each prompt completion", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-rpc-turns-"));
	const script = join(directory, "rpc-stub.mjs");
	await writeFile(script, `import readline from "node:readline";\nif (process.argv.includes("--version")) { process.stdout.write("0.85.0\\n"); process.exit(0); }\nconst sessionPath = process.argv[process.argv.indexOf("--session") + 1];\nconst input = readline.createInterface({ input: process.stdin });\nlet turns = 0;\ninput.on("line", (line) => { const request = JSON.parse(line); if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "stub-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n"); else if (request.type === "prompt") { turns += 1; process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true }) + "\\n"); if (turns === 1) process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first output" }], usage: { input: 11, output: 7, cacheRead: 13, cacheWrite: 5 } } }) + "\\n"); setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), turns === 2 ? 50 : 0); } });\n`);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script], rpcTimeoutMs: 1_000, agentTimeoutMs: 500 });
	const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "medium", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "hash" }, tools: [] });
	assert.deepEqual(await runtime.send(binding, "first", { tokenAllowance: 100 }), {
		output: "first output",
		usage: { inputTokens: 11, outputTokens: 7, cacheHitTokens: 13, cacheMissTokens: 16 },
	});
	const second = runtime.send(binding, "second", { tokenAllowance: 100 });
	assert.equal(await runtime.getState(binding), "working");
	const earlyResult = await Promise.race([second.then(() => "completed"), new Promise((resolve) => setTimeout(() => resolve("pending"), 10))]);
	assert.equal(earlyResult, "pending");
	assert.deepEqual(await second, { output: "" });
	const staleBinding = { ...binding, processMarker: "stale-process" };
	assert.equal(await runtime.getState(staleBinding), "unknown");
	await assert.rejects(runtime.send(staleBinding, "stale prompt", { tokenAllowance: 100 }), /not attached/);
	await runtime.requestStop(staleBinding);
	assert.equal(await runtime.getState(binding), "idle");
	await runtime.close();
});
function hasGithubFeedback(observations, expected, actionable) {
	const comments = observations.filter((item) => item.kind === "review-comment");
	return comments.some((item) => item.feedback?.[0] === expected && item.actionable === actionable);
}

function hasGithubFeedbackContaining(observations, expected) {
	const comments = observations.filter((item) => item.kind === "review-comment");
	return comments.some((item) => item.feedback?.[0]?.includes(expected));
}

function hasActionableGithubFeedbackContaining(observations, expected) {
	const comments = observations.filter((item) => item.kind === "review-comment");
	return comments.some((item) => item.feedback?.[0]?.includes(expected) && item.actionable === true);
}

function hasStaleGithubFeedback(observations) {
	const comments = observations.filter((item) => item.kind === "review-comment");
	return comments.some((item) => item.feedback?.[0] === "Stale review note." && item.headCommit === "old-head");
}

function assertGithubFeedback(observations) {
	assert.equal(hasGithubFeedback(observations, "Please add a regression test.", true), true);
	assert.equal(hasActionableGithubFeedbackContaining(observations, "review-level note"), true);
	assert.equal(hasGithubFeedback(observations, "Public contributor note.", false), true);
	assert.equal(hasStaleGithubFeedback(observations), true);
	assert.equal(hasGithubFeedbackContaining(observations, "Inline review note (src/index.ts:3)"), true);
}

function assertGithubChecks(observations) {
	const ciObservation = observations.find((item) => item.kind === "ci-status");
	assert.ok(ciObservation);
	assert.ok(ciObservation.details);
	assert.ok(ciObservation.details.pullRequest);
	assert.ok(Array.isArray(ciObservation.details.comments));
	assert.ok(ciObservation.details.comments.length >= 4);
	assert.ok(Array.isArray(ciObservation.details.checks));
	assert.ok(ciObservation.details.checks.length >= 2);
	assert.equal(ciObservation.status, "merged");
	assert.equal(ciObservation.details.pullRequest.status, "merged");
	assert.equal(ciObservation.details.comments.length <= 8, true);
	assert.equal(ciObservation.details.comments.some((comment) => comment.body === ""), false);
	assert.equal(ciObservation.details.comments[3].body.length <= 500, true);
	assert.equal(JSON.stringify(ciObservation).length <= 64_000, true);
	assert.equal(ciObservation.details.comments.some((comment) => comment.createdAt === "2026-08-25T21:12:06Z"), true);
	assert.equal(ciObservation.details.comments.some((comment) => comment.location === "src/index.ts:3"), true);
	assert.deepEqual(ciObservation.details.checks.map((check) => check.kind), ["check-run", "status-context"]);
	assert.equal(ciObservation.details.checks[1].name, "coverage");
	assert.equal(ciObservation.details.checks[1].detailsUrl, "https://github.com/example/project/checks/coverage");
}

function assertGithubCommands(commands) {
	const create = commands.find((args) => args[1] === "create");
	assert.ok(create);
	assert.equal(create.includes("--head"), true);
	assert.equal(create[create.indexOf("--head") + 1], "khala/branch");
	const pollingView = commands.find((args) => args[1] === "view" && args.includes("state,isDraft,mergedAt,reviewDecision,statusCheckRollup,comments,reviews,headRefName,baseRefName,headRefOid,baseRefOid"));
	assert.ok(pollingView);
}

test("GitHub publication uses the sandbox branch and current head", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-code-host-"));
	const commandDirectory = await mkdtemp(join(directory, "bin-"));
	const log = join(directory, "commands.log");
	const gh = join(commandDirectory, "gh");
	await writeFile(gh, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nconst polling = args.includes("state,isDraft,mergedAt,reviewDecision,statusCheckRollup,comments,reviews,headRefName,baseRefName,headRefOid,baseRefOid");\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");\nif (args[0] === "api" && args[1] === "user") process.stdout.write("principal\\n");\nelse if (args[0] === "api") process.stdout.write(JSON.stringify([[{ id: 10, body: "Inline review note", path: "src/index.ts", line: 3, user: { login: "principal" }, author_association: "OWNER" }, ...Array.from({ length: 40 }, (_, index) => ({ id: index + 100, body: "x".repeat(4_000), user: { login: "principal" }, author_association: "OWNER" }))]]));\nelse if (args[0] === "repo") process.stdout.write("example/project\\n");\nelse if (args[1] === "list") process.stdout.write("[]");\nelse if (args[1] === "create") process.stdout.write("https://github.com/example/project/pull/42\\n");\nelse if (args[1] === "view") process.stdout.write(JSON.stringify({ number: 42, url: "https://github.com/example/project/pull/42", state: polling ? "MERGED" : "OPEN", mergedAt: polling ? "2026-08-26T00:00:00Z" : null, isDraft: true, headRefName: "khala/branch", baseRefName: "main", headRefOid: "head", comments: [{ id: 7, body: "Please add a regression test.", author: { login: "principal" }, authorAssociation: "OWNER", createdAt: "2026-08-25T21:11:06Z", url: "https://github.com/example/project/pull/42#issuecomment-7" }], reviews: [{ id: 8, state: "COMMENTED", body: "", author: { login: "principal" }, authorAssociation: "OWNER", submittedAt: "2026-08-25T21:10:06Z" }, { id: 9, state: "CHANGES_REQUESTED", body: "Please add a review-level note.", author: { login: "reviewer" }, authorAssociation: "OWNER", submittedAt: "2026-08-25T21:12:06Z" }, { id: 10, state: "COMMENTED", body: "Stale review note.", author: { login: "reviewer" }, authorAssociation: "OWNER", submittedAt: "2026-08-25T21:13:06Z", commit_id: "old-head" }, { id: 11, state: "COMMENTED", body: "Public contributor note.", author: { login: "contributor" }, authorAssociation: "CONTRIBUTOR", submittedAt: "2026-08-25T21:14:06Z" }], statusCheckRollup: [{ __typename: "CheckRun", name: "validate", status: "COMPLETED", conclusion: "FAILURE", workflowName: "CI" }, { __typename: "StatusContext", context: "coverage", state: "SUCCESS", targetUrl: "https://github.com/example/project/checks/coverage" }] }));\nelse if (args[1] === "diff") process.stdout.write("diff");\n`);
	await chmod(gh, 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${commandDirectory}:${previousPath ?? ""}`;
	try {
		const host = new CommandCodeHost("github", directory);
		const request = await host.ensureReviewRequest({
			workId: "work-1",
			mission: { missionId: "mission-1", workId: "work-1", assignment: { title: "Feature", objective: "Implement", context: "", scope: "scope", acceptanceCriteria: ["works"], constraints: [], validation: ["npm test"], allowedPaths: ["."], maxTokens: 100 }, mandateRevision: 1, createdAt: new Date().toISOString() },
			execution: { executionId: "execution-1", workId: "work-1", missionId: "mission-1", state: "running", model: "model", thinking: "high", tokenAllowance: 50, promptIdentity: { packageVersion: "1", promptSha256: "hash" }, sandbox: { path: directory, baseCommit: "base", branch: "khala/branch" } },
			terms: { title: "Feature", objective: "Implement", context: "", scope: "scope", acceptanceCriteria: ["works"], constraints: [], validation: ["npm test"], allowedPaths: ["."], maxTokens: 100 },
			sandbox: { path: directory, baseCommit: "base", branch: "khala/branch" },
			headCommit: "head",
			targetBranch: "main",
			draftMarker: "Khala-Work: work-1",
		});
		assert.equal(request.sourceBranch, "khala/branch");
		const observations = await host.poll(request);
		assertGithubFeedback(observations);
		assertGithubChecks(observations);
		const commands = (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assertGithubCommands(commands);
	} finally {
		restorePath(previousPath);
	}
});

test("Provider closure wakes the Conclave with closure-specific guidance", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-provider-closed-wake-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	const running = await admitAndStart(service, "provider-closed-wake");
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "provider-closed-wake:review", running.revision, running.workId, running.execution.executionId),
	});
	controls.pollObservations = [
		{
			observationId: "closed:42",
			kind: "ci-status",
			providerId: review.value.reviewRequest.providerId,
			status: "closed",
			summary: "The review was closed.",
			repository: review.value.reviewRequest.repository,
			sourceBranch: review.value.reviewRequest.sourceBranch,
			targetBranch: review.value.reviewRequest.targetBranch,
			headCommit: review.value.reviewRequest.headCommit,
			changed: true,
			observedAt: new Date().toISOString(),
		},
	];
	await service.pollProvider(running.workId, meta("user", "provider-closed-wake:poll", review.value.revision));
	await service.processPendingEffects();
	assert.equal(
		controls.prompts.some((entry) => entry.message.includes("closed provider review") && entry.message.includes("closure as acceptance")),
		true,
	);
	await service.close();
});

test("Pull request templates cannot read files through repository symlinks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-template-"));
	const secret = join(directory, "secret.txt");
	const githubDirectory = join(directory, ".github");
	await mkdir(githubDirectory, { recursive: true });
	await writeFile(secret, "private content");
	await symlink(secret, join(githubDirectory, "pull_request_template.md"));
	assert.equal(await readPullRequestTemplate(directory), undefined);
});

test("Oracle keeps advisory output bounded and origin matching rejects lookalike hosts", async () => {
	const oracle = new PiOracle({
		async ensureSession() {
			return { sessionId: "oracle-session", sessionPath: "/tmp/oracle-session.jsonl" };
		},
		async send() {
			return { usage: ZERO_USAGE, output: "Verdict: Needs revision\n\nFindings:\n- [major] Missing test | Evidence: no test result\n\nValidation gaps:\n- integration test not run" };
		},
		async getState() {
			return "idle";
		},
		async requestStop() {},
		async close() {},
	}, "/project", { packageVersion: "1.1.0", promptSha256: "oracle" });
	const result = await oracle.review({ subject: "Review", mission: { missionId: "m", workId: "w", assignment: { title: "T", objective: "O", context: "", scope: "S", acceptanceCriteria: ["A"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 }, mandateRevision: 1, createdAt: new Date().toISOString() }, diff: "diff", validation: ["check"], providerEvidence: [] }, "provider/oracle", "high", { tokenAllowance: 100 });
	assert.equal(result.verdict, "needs-revision");
	assert.equal(result.findings[0].summary, "Missing test");
	const incompleteOracle = new PiOracle({
		async ensureSession() {
			return { sessionId: "oracle-session", sessionPath: "/tmp/oracle-session.jsonl" };
		},
		async send() {
			return { usage: ZERO_USAGE, output: "analysis\nVerdict: Pass\n\nFindings:" };
		},
		async getState() {
			return "idle";
		},
		async requestStop() {},
		async close() {},
	}, "/project", { packageVersion: "1.1.0", promptSha256: "oracle" });
	const incomplete = await incompleteOracle.review({ subject: "Review", mission: { missionId: "m", workId: "w", assignment: { title: "T", objective: "O", context: "", scope: "S", acceptanceCriteria: ["A"], constraints: [], validation: ["check"], allowedPaths: ["."], maxTokens: 100 }, mandateRevision: 1, createdAt: new Date().toISOString() }, diff: "diff", validation: ["check"], providerEvidence: [] }, "provider/oracle", "high", { tokenAllowance: 100 });
	assert.equal(incomplete.verdict, "incomplete");
	assert.equal(codeHostForOrigin("git@github.com:example/project.git", "/project").provider, "github");
	assert.equal(codeHostForOrigin("https://gitlab.com/example/project.git", "/project").provider, "gitlab");
	assert.throws(() => codeHostForOrigin("https://github.com.attacker.example/project.git", "/project"));
});
