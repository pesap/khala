import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../dist/src/run-ledger.js";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { admitAndStart, makeService, meta, ZERO_USAGE } from "./helpers/mvp-fixtures.mjs";

async function cancelRunning(service, prefix) {
	const running = await admitAndStart(service, prefix);
	const cancelled = await service.perform({
		action: "cancel",
		workId: running.workId,
		input: {},
		meta: meta("user", `${prefix}:cancel`, running.revision, running.workId),
	});
	assert.equal("error" in cancelled, false);
	return cancelled.value;
}

function recover(service, work, commandId) {
	return service.perform({
		action: "recover",
		workId: work.workId,
		input: {},
		meta: meta("user", commandId, work.revision, work.workId),
	});
}

function assertCancellationPreserved(service, cancelled) {
	const current = service.inspectWork(cancelled.workId);
	assert.equal(current.revision, cancelled.revision);
	assert.equal(current.state, "stopped");
	assert.equal(current.stopReason, "cancelled");
	assert.equal(current.execution.executionId, cancelled.execution.executionId);
	assert.deepEqual(current.execution.pi, cancelled.execution.pi);
	return current;
}

async function queueExecution(service, prefix) {
	const submitted = service.submitWork(
		{ title: "Queued cancellation", objective: "Recover before launch", acceptanceCriteria: ["Recovered"] },
		meta("user", `${prefix}:submit`, 0),
	);
	const admitted = await service.perform({
		action: "admit",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", `${prefix}:admit`, submitted.revision, submitted.workId),
	});
	return service.perform({
		action: "start-execution",
		workId: submitted.workId,
		input: {},
		meta: meta("conclave", `${prefix}:start`, admitted.value.revision, submitted.workId),
	});
}

test("cancelled queued Work skips stopping a durably never-launched Pi binding", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-never-launched-recovery-"));
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, "unused-pi.mjs"] });
	const { service, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: { runtime: { requestStop: (binding) => runtime.requestStop(binding) } },
	});
	try {
		const queued = await queueExecution(service, "never-launched-recovery");
		assert.equal(queued.value.execution.state, "queued");
		assert.equal(
			archive.query({ executionId: queued.value.execution.executionId, kinds: ["invocation"] }).items.length,
			0,
		);
		const cancelledResult = await service.perform({
			action: "cancel",
			workId: queued.value.workId,
			input: {},
			meta: meta("user", "never-launched-recovery:cancel", queued.value.revision, queued.value.workId),
		});
		const recovered = await recover(service, cancelledResult.value, "never-launched-recovery:recover");
		assert.equal("error" in recovered, false);
		assert.equal(recovered.value.state, "submitted");
		assert.equal(recovered.value.execution, undefined);
	} finally {
		await service.close();
	}
});

test("pending-shaped binding with invocation history still requires ownership proof", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-pending-history-recovery-"));
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, "unused-pi.mjs"] });
	const { service, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: { runtime: { requestStop: (binding) => runtime.requestStop(binding) } },
	});
	try {
		const queued = await queueExecution(service, "pending-history-recovery");
		const ledger = new RunLedger(archive);
		const reservation = ledger.reserve({
			workId: queued.value.workId,
			role: "executor",
			executionId: queued.value.execution.executionId,
			missionId: queued.value.mission.missionId,
			allowance: 20,
		});
		ledger.settle({ runId: reservation.runId, usage: ZERO_USAGE, complete: true });
		const settled = service.inspectWork(queued.value.workId);
		assert.equal(settled.activeInvocations.length, 0);
		const cancelledResult = await service.perform({
			action: "cancel",
			workId: settled.workId,
			input: {},
			meta: meta("user", "pending-history-recovery:cancel", settled.revision, settled.workId),
		});
		const cancelled = cancelledResult.value;
		const refused = await recover(service, cancelled, "pending-history-recovery:recover");
		assert.equal(refused.error.code, "external-failure");
		assert.match(refused.error.summary, /process group/i);
		assertCancellationPreserved(service, cancelled);
	} finally {
		await service.close();
	}
});

async function assertHeldRecoveryRefused(invocationState) {
	const directory = await mkdtemp(join(tmpdir(), `khala-${invocationState}-cancel-recovery-`));
	const archivePath = join(directory, "archive.sqlite");
	const owner = makeService(archivePath);
	let contender;
	try {
		const prefix = `${invocationState}-cancel-recovery`;
		const running = await admitAndStart(owner.service, prefix);
		const ledger = new RunLedger(owner.archive);
		const reservation = ledger.reserve({
			workId: running.workId,
			role: "executor",
			executionId: running.execution.executionId,
			missionId: running.mission.missionId,
			allowance: 20,
		});
		if (invocationState === "uncertain") ledger.settle({ runId: reservation.runId, usage: ZERO_USAGE, complete: false });
		const held = owner.service.inspectWork(running.workId);
		assert.equal(held.activeInvocations[0].state, invocationState);
		const cancelledResult = await owner.service.perform({
			action: "cancel",
			workId: held.workId,
			input: {},
			meta: meta("user", `${prefix}:cancel`, held.revision, held.workId),
		});
		const cancelled = cancelledResult.value;

		const refused = await recover(owner.service, cancelled, `${prefix}:recover-owner`);
		assert.equal(refused.error.code, "invalid-state");
		assert.match(refused.error.summary, /invocation.*settle/i);
		assertCancellationPreserved(owner.service, cancelled);

		contender = makeService(archivePath);
		const competing = await recover(contender.service, cancelled, `${prefix}:recover-contender`);
		assert.equal(competing.error.code, "invalid-state");
		assert.match(competing.error.summary, /owning Archive supervisor/i);
		assertCancellationPreserved(owner.service, cancelled);
	} finally {
		await contender?.service.close();
		await owner.service.close();
	}
}

test("cancelled Work with held invocations cannot discard its stopping authority", async () => {
	for (const invocationState of ["reserved", "uncertain"]) await assertHeldRecoveryRefused(invocationState);
});

test("runtime stop refusal preserves cancelled Work and its Execution", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-refused-cancel-recovery-"));
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: { runtime: { async requestStop() { throw new Error("stop refused"); } } },
	});
	try {
		const cancelled = await cancelRunning(service, "refused-cancel-recovery");
		const refused = await recover(service, cancelled, "refused-cancel-recovery:recover");
		assert.equal(refused.error.code, "external-failure");
		assert.match(refused.error.summary, /stop refused/i);
		assertCancellationPreserved(service, cancelled);
	} finally {
		await service.close();
	}
});

test("cancelled Work recovers after its bound writer acknowledges stopping", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-safe-cancel-recovery-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"));
	try {
		const cancelled = await cancelRunning(service, "safe-cancel-recovery");
		const recovered = await recover(service, cancelled, "safe-cancel-recovery:recover");
		assert.equal("error" in recovered, false);
		assert.equal(controls.stopped.length, 1);
		assert.deepEqual(controls.stopped[0], cancelled.execution.pi);
		assert.equal(recovered.value.state, "submitted");
		assert.equal(recovered.value.stopReason, undefined);
		assert.equal(recovered.value.execution, undefined);
	} finally {
		await service.close();
	}
});

test("cancelled recovery preserves a concurrent User change made while stop is acknowledged", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-delayed-stop-recovery-"));
	let acknowledgeStop;
	let stopStarted;
	const stopping = new Promise((resolve) => {
		stopStarted = resolve;
	});
	const { service } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				requestStop() {
					stopStarted();
					return new Promise((resolve) => {
						acknowledgeStop = resolve;
					});
				},
			},
		},
	});
	try {
		const cancelled = await cancelRunning(service, "delayed-stop-recovery");
		const recovering = recover(service, cancelled, "delayed-stop-recovery:recover");
		await stopping;
		const renamed = await service.perform({
			action: "rename-work",
			workId: cancelled.workId,
			input: { title: "Renamed while stopping" },
			meta: meta("user", "delayed-stop-recovery:rename", cancelled.revision, cancelled.workId),
		});
		assert.equal("error" in renamed, false);
		acknowledgeStop();
		const stale = await recovering;
		assert.equal(stale.error.code, "revision-conflict");
		const current = service.inspectWork(cancelled.workId);
		assert.equal(current.revision, renamed.value.revision);
		assert.equal(current.terms.title, "Renamed while stopping");
		assert.equal(current.state, "stopped");
		assert.equal(current.stopReason, "cancelled");
		assert.equal(current.execution.executionId, cancelled.execution.executionId);
		assert.deepEqual(current.execution.pi, cancelled.execution.pi);
	} finally {
		acknowledgeStop?.();
		await service.close();
	}
});
