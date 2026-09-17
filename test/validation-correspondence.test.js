import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admitAndStart, makeService, meta, validateWork } from "./helpers/mvp-fixtures.mjs";

test("exit-zero validation records failure when the command changes tracked source", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-correspondence-"));
	let changed = false;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async inspectChanges({ baseCommit }) {
					return changed && baseCommit === "head" ? ["src/changed.ts"] : [];
				},
				async runValidation({ commands }) {
					changed = true;
					return commands.map((command) => ({ command, passed: true, output: "exit 0" }));
				},
			},
		},
	});
	try {
		const running = await admitAndStart(service, "validation-mutates-source");
		const result = await service.perform({
			action: "run-validation",
			workId: running.workId,
			input: {},
			meta: meta(
				"executor",
				"validation-mutates-source:run",
				running.revision,
				running.workId,
				running.execution.executionId,
			),
		});
		assert.equal(result.value.lastValidation.results[0].passed, true);
		assert.equal(result.value.lastValidation.results[0].output, "exit 0");
		assert.equal(result.value.lastValidation.sourceVerified, false);
		assert.match(result.value.lastValidation.sourceFailure, /differs.*src\/changed\.ts/i);
		assert.match(result.value.nextAction, /source/i);
	} finally {
		await service.close();
	}
});

test("dirty source before validation does not execute commands or retain earlier authority", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-dirty-before-"));
	let dirty = false;
	let runs = 0;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async inspectChanges() {
					return dirty ? ["src/dirty.ts"] : [];
				},
				async runValidation({ commands }) {
					runs += 1;
					return commands.map((command) => ({ command, passed: true, output: "real output" }));
				},
			},
		},
	});
	try {
		const running = await admitAndStart(service, "dirty-before");
		const verified = await validateWork(service, running, "dirty-before:first");
		dirty = true;
		const second = await service.perform({
			action: "run-validation",
			workId: running.workId,
			input: {},
			meta: meta("executor", "dirty-before:second", verified.revision, running.workId, running.execution.executionId),
		});
		assert.equal(runs, 1);
		assert.equal(second.value.lastValidation.sourceVerified, false);
		assert.deepEqual(second.value.lastValidation.results, []);
		assert.match(second.value.lastValidation.sourceFailure, /src\/dirty\.ts/);
	} finally {
		await service.close();
	}
});

test("validation retains command diagnostics when an exit-zero command changes HEAD", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-head-change-"));
	let head = "head";
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				async inspectHead() {
					return head;
				},
				async runValidation({ commands }) {
					head = "committed-during-validation";
					return commands.map((command) => ({ command, passed: true, output: "commit succeeded" }));
				},
			},
		},
	});
	try {
		const running = await admitAndStart(service, "head-change");
		const result = await service.perform({
			action: "run-validation",
			workId: running.workId,
			input: {},
			meta: meta("executor", "head-change:run", running.revision, running.workId, running.execution.executionId),
		});
		assert.equal(result.value.lastValidation.sourceVerified, false);
		assert.match(result.value.lastValidation.sourceFailure, /HEAD differs/);
		assert.equal(result.value.lastValidation.results[0].output, "commit succeeded");
	} finally {
		await service.close();
	}
});

test("dirty source after validation blocks ready and handoff until a clean rerun", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-ready-"));
	let dirty = false;
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: { workspace: { async inspectChanges() { return dirty ? ["untracked.generated.ts"] : []; } } },
	});
	try {
		const running = await admitAndStart(service, "ready-source");
		let current = await validateWork(service, running, "ready-source:validate");
		const review = await service.perform({
			action: "create-review-request",
			workId: current.workId,
			input: {},
			meta: meta("executor", "ready-source:review", current.revision, current.workId, current.execution.executionId),
		});
		current = review.value;
		dirty = true;
		const deniedReady = await service.perform({
			action: "record-signal",
			workId: current.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["validation"] },
			meta: meta("executor", "ready-source:dirty", current.revision, current.workId, current.execution.executionId),
		});
		assert.equal(deniedReady.error.code, "invalid-state");
		dirty = false;
		current = await validateWork(service, current, "ready-source:rerun");
		const ready = await service.perform({
			action: "record-signal",
			workId: current.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["validation"] },
			meta: meta("executor", "ready-source:ready", current.revision, current.workId, current.execution.executionId),
		});
		dirty = true;
		const deniedHandoff = await service.perform({
			action: "verdict",
			workId: current.workId,
			input: { decision: "handoff", reason: "Complete", signalId: ready.value.lastSignal.signalId },
			meta: meta("conclave", "ready-source:handoff", ready.value.revision, current.workId),
		});
		assert.equal(deniedHandoff.error.code, "invalid-state");
		assert.equal(service.inspectWork(current.workId).state, "active");
	} finally {
		await service.close();
	}
});

test("missing source inspection and historical unverified validation fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-capabilities-"));
	const missing = makeService(join(directory, "missing.sqlite"), {
		ports: { workspace: { inspectChanges: undefined } },
	});
	try {
		const running = await admitAndStart(missing.service, "missing-inspector");
		const result = await missing.service.perform({
			action: "run-validation",
			workId: running.workId,
			input: {},
			meta: meta("executor", "missing-inspector:run", running.revision, running.workId, running.execution.executionId),
		});
		assert.equal(result.error.code, "external-failure");
	} finally {
		await missing.service.close();
	}

	const historical = makeService(join(directory, "historical.sqlite"));
	try {
		const running = await admitAndStart(historical.service, "historical-proof");
		const verified = await validateWork(historical.service, running, "historical-proof:validate");
		const review = await historical.service.perform({
			action: "create-review-request",
			workId: verified.workId,
			input: {},
			meta: meta("executor", "historical-proof:review", verified.revision, verified.workId, verified.execution.executionId),
		});
		const current = review.value;
		const legacyValidation = {
			executionId: current.lastValidation.executionId,
			headCommit: current.lastValidation.headCommit,
			results: current.lastValidation.results,
		};
		historical.archive.append({
			commandId: "historical-proof:strip",
			expectedWorkRevision: current.revision,
			kind: "validation",
			actor: "system",
			workId: current.workId,
			executionId: current.execution.executionId,
			payloadVersion: 1,
			summary: "Historical validation without source proof.",
			payload: legacyValidation,
			projection: { ...current, revision: current.revision + 1, lastValidation: legacyValidation },
		});
		const legacy = historical.service.inspectWork(current.workId);
		const denied = await historical.service.perform({
			action: "record-signal",
			workId: current.workId,
			input: { kind: "ready", summary: "Ready", evidence: ["legacy validation"] },
			meta: meta("executor", "historical-proof:ready", legacy.revision, current.workId, current.execution.executionId),
		});
		assert.equal(denied.error.code, "invalid-state");
	} finally {
		await historical.service.close();
	}
});
