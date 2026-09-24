import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService, performCurrent, workWithCiFailure } from "./helpers/ci-repair-fixtures.mjs";

function claimEffectOfKind(archive, owner, kind) {
	const claimed = [];
	let selected;
	while (true) {
		const effect = archive.pendingEffects(owner, claimed.map((item) => item.effectId))[0];
		if (effect === undefined) break;
		claimed.push(effect);
		if (effect.kind === kind) {
			selected = effect;
			break;
		}
	}
	assert.ok(selected);
	claimed.filter((effect) => effect !== selected).forEach((effect) => archive.releaseEffect(effect.effectId, owner));
	return selected;
}

function repairStatuses(archive, workId) {
	return archive.query({ workId, kinds: ["delivery"] }).items
		.filter((record) => record.payload.kind === "ci-repair")
		.map((record) => record.payload.status)
		.sort();
}

async function waitForHeldExecutor(controls) {
	for (let attempt = 0; attempt < 100 && controls.releaseExecutor === undefined; attempt += 1)
		await new Promise((resolve) => setImmediate(resolve));
	assert.ok(controls.releaseExecutor !== undefined);
}

test("duplicate wake cannot block a repair between runtime ownership and durable start", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-ci-start-race-"));
	let holdStartProbe = false;
	let startProbeReads = 0;
	let enterStartProbe = () => undefined;
	let releaseStartProbe = () => undefined;
	const startProbeEntered = new Promise((resolve) => {
		enterStartProbe = resolve;
	});
	const startProbeGate = new Promise((resolve) => {
		releaseStartProbe = resolve;
	});
	const { service, controls, archive } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			runtime: {
				async getState() {
					if (holdStartProbe) {
						startProbeReads += 1;
						if (startProbeReads === 2) {
							enterStartProbe();
							await startProbeGate;
						}
					}
					return "idle";
				},
			},
		},
	});
	const effectOwner = "ci-repair-start-race-test";
	let repairWake;
	let firstWake;
	try {
		const { work } = await workWithCiFailure(service, controls, "ci-start-race");
		const authorized = await performCurrent(service, "conclave", "repair-ci", "ci-start-race:authorize", {
			observationId: work.lastObservation.observationId,
			evidence: ["1"],
		});
		assert.equal("error" in authorized, false);
		repairWake = claimEffectOfKind(archive, effectOwner, "ci-repair-wake");
		controls.executorHold = true;
		holdStartProbe = true;
		firstWake = service.ciRepair.processWake(repairWake);
		await startProbeEntered;

		assert.deepEqual(repairStatuses(archive, work.workId), ["authorized"]);
		await service.ciRepair.processWake(repairWake);
		assert.deepEqual(repairStatuses(archive, work.workId), ["authorized"]);

		releaseStartProbe();
		await waitForHeldExecutor(controls);
		assert.deepEqual(repairStatuses(archive, work.workId), ["authorized", "started"]);
		controls.releaseExecutor();
		await firstWake;
		assert.deepEqual(repairStatuses(archive, work.workId), ["authorized", "blocked", "started"]);
		const blocked = archive.query({ workId: work.workId, kinds: ["delivery"] }).items.find(
			(record) => record.payload.kind === "ci-repair" && record.payload.status === "blocked",
		);
		assert.doesNotMatch(blocked.payload.reason, /active Executor turn|already started/);
	} finally {
		releaseStartProbe();
		controls.releaseExecutor?.();
		if (firstWake !== undefined) await firstWake.catch(() => undefined);
		if (repairWake !== undefined) archive.releaseEffect(repairWake.effectId, effectOwner);
		await service.close();
	}
});
