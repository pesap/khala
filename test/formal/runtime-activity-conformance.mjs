import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { fixture } from "../helpers/runtime-activity-fixture.mjs";

const model = fileURLToPath(new URL("./runtime-activity.bend", import.meta.url));

function subscribe(runtime, binding, sameBinding, subscribed, onChange) {
	if (!sameBinding) {
		assert.throws(() => runtime.observe({ ...binding, processMarker: "stale" }, onChange), /not attached/i);
		return;
	}
	const subscription = runtime.observe(binding, onChange);
	if (!subscribed) subscription.close();
	return subscription;
}

async function closeWithHistory(runtime, binding, subscription, reset) {
	let retained;
	if (subscription !== undefined) {
		await runtime.send(binding, "work", { tokenAllowance: 100 });
		retained = subscription.snapshot().entries;
		assert.ok(retained.length > 0);
		reset();
	}
	await runtime.close();
	if (subscription !== undefined) {
		assert.equal(subscription.snapshot().state, "ended");
		assert.deepEqual(subscription.snapshot().entries, retained);
	}
	await assert.rejects(runtime.send(binding, "work", { tokenAllowance: 100 }), /not attached/i);
}

test("runtime observation agrees with the verified Bend delivery model", { timeout: 120_000 }, async (t) => {
	const bend = process.env.KHALA_BEND_SOURCE;
	assert.ok(bend, "Set KHALA_BEND_SOURCE to bend2/main.ts from the pinned Bend checkout.");
	const options = { encoding: "utf8", env: { ...process.env, BEND_NO_TELEMETRY: "1" } };
	const verdict = execFileSync("bun", [bend, model, "--verdict"], options);
	assert.match(verdict, /ALL PROOFS CHECK/);
	const output = execFileSync("bun", [bend, model], options).trim();
	assert.match(output, /^\[(?:False\{\}|True\{\})(?:, (?:False\{\}|True\{\})){7}\]$/);
	const expected = output.match(/(?:False|True)\{\}/g).map((value) => value === "True{}");
	let index = 0;
	for (const attached of [false, true]) {
		for (const subscribed of [false, true]) {
			for (const sameBinding of [false, true]) {
				const modelResult = expected[index++];
				await t.test(`attached=${attached} subscribed=${subscribed} sameBinding=${sameBinding}`, async (scenario) => {
					const { runtime, binding } = await fixture(scenario);
					let delivered = false;
					const subscription = subscribe(runtime, binding, sameBinding, subscribed, () => {
						const snapshot = subscription.snapshot();
						if (snapshot.state === "attached" && snapshot.entries.length > 0) delivered = true;
					});
					if (attached) {
						await runtime.send(binding, "work", { tokenAllowance: 100 });
					} else {
						await closeWithHistory(runtime, binding, subscribed ? subscription : undefined, () => { delivered = false; });
					}
					assert.equal(delivered, modelResult);
					subscription?.close();
				});
			}
		}
	}
});
