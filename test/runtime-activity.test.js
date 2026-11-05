import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fixture } from "./helpers/runtime-activity-fixture.mjs";

test("an attached session exposes bounded assistant and tool activity without changing the turn", async (t) => {
	const { runtime, binding } = await fixture(t);
	const updates = [];
	const subscription = runtime.observe(binding, () => updates.push(subscription.snapshot()));
	const turn = await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(turn.output, "Hello 🌱!");
	assert.deepEqual(subscription.snapshot().entries, [
		{ kind: "message", text: "Hello 🌱!", truncated: false },
		{ kind: "tool", callId: "call-1", name: "read", phase: "started" },
		{ kind: "tool", callId: "call-1", name: "read", phase: "succeeded" },
	]);
	assert.ok(updates.some((snapshot) => snapshot.entries.some((entry) => entry.kind === "message" && entry.text === "Hello ")));
	assert.doesNotMatch(JSON.stringify(subscription.snapshot()), /PRIVATE_THINKING|PRIVATE_ARGUMENT|PRIVATE_RESULT/);
	subscription.close();
	assert.throws(() => subscription.snapshot(), /closed/i);
});

test("retained activity is bounded and reports evicted entries", async (t) => {
	const { runtime, binding } = await fixture(t);
	const subscription = runtime.observe(binding, () => {});
	await runtime.send(binding, "overflow", { tokenAllowance: 100 });
	const snapshot = subscription.snapshot();
	assert.equal(snapshot.entries.length, 100);
	assert.equal(snapshot.discarded, 5);
	assert.equal(snapshot.entries[0].callId, "call-5");
	assert.equal(snapshot.entries.at(-1).callId, "call-104");
	assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_ARGUMENT/);
	subscription.close();
});

test("long assistant messages are bounded and terminal controls are removed", async (t) => {
	const { runtime, binding } = await fixture(t);
	const subscription = runtime.observe(binding, () => {});
	await runtime.send(binding, "long", { tokenAllowance: 100 });
	const entry = subscription.snapshot().entries[0];
	assert.equal(entry.kind, "message");
	assert.equal(entry.text.length, 4_000);
	assert.equal(entry.truncated, true);
	assert.equal(entry.text, "x".repeat(4_000));
	subscription.close();
});

test("streaming truncation remains visible and never splits a Unicode character", async (t) => {
	const { runtime, binding } = await fixture(t);
	const snapshots = [];
	const subscription = runtime.observe(binding, () => snapshots.push(subscription.snapshot()));
	await runtime.send(binding, "clipping", { tokenAllowance: 100 });
	assert.ok(snapshots.length >= 2);
	for (const snapshot of snapshots) {
		const entry = snapshot.entries[0];
		assert.equal(entry.truncated, true);
		assert.equal(entry.text, "x".repeat(3999));
	}
	subscription.close();
});

test("Unicode characters split across separate delta events remain intact while streaming", async (t) => {
	const { runtime, binding } = await fixture(t);
	const snapshots = [];
	const subscription = runtime.observe(binding, () => snapshots.push(subscription.snapshot()));
	await runtime.send(binding, "unicode", { tokenAllowance: 100 });
	assert.ok(snapshots.length >= 2);
	assert.ok(snapshots.some((snapshot) => snapshot.entries.some((entry) => entry.text === "🌱")));
	for (const snapshot of snapshots) {
		for (const entry of snapshot.entries) assert.ok(entry.text.isWellFormed());
	}
	subscription.close();
});

test("terminal sequences split across deltas never leak into streaming snapshots", async (t) => {
	const { runtime, binding } = await fixture(t);
	const snapshots = [];
	const subscription = runtime.observe(binding, () => snapshots.push(subscription.snapshot()));
	await runtime.send(binding, "ansi-split", { tokenAllowance: 100 });
	assert.ok(snapshots.length >= 3);
	for (const snapshot of snapshots) assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_TITLE|31m/);
	assert.deepEqual(subscription.snapshot().entries, [
		{ kind: "message", text: "BeforeVisible", truncated: false },
		{ kind: "message", text: "Styled", truncated: false },
	]);
	subscription.close();
});

test("replacing a subscriber inside its callback does not repeat the same update", async (t) => {
	const { runtime, binding } = await fixture(t);
	const seen = new Set();
	let duplicate = false;
	let subscription;
	const onChange = () => {
		const snapshot = JSON.stringify(subscription.snapshot());
		if (seen.has(snapshot)) { duplicate = true; return; }
		seen.add(snapshot);
		subscription.close();
		subscription = runtime.observe(binding, onChange);
	};
	subscription = runtime.observe(binding, onChange);
	await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(duplicate, false);
	subscription.close();
});

test("a failing subscriber cannot interrupt the turn or another subscriber", async (t) => {
	const { runtime, binding } = await fixture(t);
	let notifications = 0;
	const failing = runtime.observe(binding, () => { throw new Error("viewer failed"); });
	const rejected = runtime.observe(binding, async () => { throw new Error("viewer rejected"); });
	const healthy = runtime.observe(binding, () => { notifications += 1; });
	const turn = await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(turn.output, "Hello 🌱!");
	assert.ok(notifications > 0);
	assert.equal(healthy.snapshot().entries.at(-1).phase, "succeeded");
	failing.close();
	rejected.close();
	healthy.close();
});

test("a rejected promise from another realm does not interrupt runtime activity", async (t) => {
	const { runtime, binding } = await fixture(t);
	const rejectFromAnotherRealm = runInNewContext("() => Promise.reject(new Error('foreign rejection'))");
	const subscription = runtime.observe(binding, rejectFromAnotherRealm);
	const turn = await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(turn.output, "Hello 🌱!");
	await new Promise((resolve) => setTimeout(resolve, 10));
	subscription.close();
});

test("closing a subscription stops notifications without stopping the session", async (t) => {
	const { runtime, binding } = await fixture(t);
	let notifications = 0;
	const subscription = runtime.observe(binding, () => { notifications += 1; });
	await runtime.send(binding, "work", { tokenAllowance: 100 });
	const count = notifications;
	assert.ok(count > 0);
	subscription.close();
	subscription.close();
	await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(notifications, count);
	assert.equal(await runtime.getState(binding), "idle");
});

test("an exiting child retains its final output and usage after a burst", async (t) => {
	const { runtime, binding } = await fixture(t);
	const subscription = runtime.observe(binding, () => {});
	const turn = await runtime.send(binding, "exit-after-output", { tokenAllowance: 100 });
	assert.equal(turn.output, "final output");
	assert.equal(turn.usage.inputTokens, 3);
	assert.equal(turn.usage.outputTokens, 4);
	assert.equal(subscription.snapshot().entries.at(-1).text, "final output");
	for (let attempt = 0; attempt < 100 && subscription.snapshot().state !== "ended"; attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(subscription.snapshot().state, "ended");
	subscription.close();
});

test("concurrent shutdown calls both wait until observation has ended", async (t) => {
	const { runtime, binding } = await fixture(t);
	const subscription = runtime.observe(binding, () => {});
	const order = [];
	const first = runtime.close().then(() => order.push("first"));
	const second = runtime.close().then(() => {
		assert.equal(subscription.snapshot().state, "ended");
		order.push("second");
	});
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first", "second"]);
	subscription.close();
});

test("ending an observed session notifies the viewer without adding to retained history", async (t) => {
	const { runtime, binding } = await fixture(t);
	const snapshots = [];
	const subscription = runtime.observe(binding, () => snapshots.push(subscription.snapshot()));
	await runtime.send(binding, "work", { tokenAllowance: 100 });
	const retained = subscription.snapshot().entries;
	assert.ok(retained.length > 0);
	await runtime.close();
	assert.equal(snapshots.at(-1).state, "ended");
	assert.deepEqual(snapshots.at(-1).entries, retained);
	subscription.close();
});

test("runtime shutdown ends existing observation and rejects new subscribers", async (t) => {
	const { runtime, binding } = await fixture(t);
	let notifications = 0;
	const subscription = runtime.observe(binding, () => { notifications += 1; });
	await runtime.close();
	assert.equal(subscription.snapshot().state, "ended");
	assert.equal(notifications, 1);
	assert.throws(() => runtime.observe(binding, () => {}), /not attached/i);
	subscription.close();
});

test("non-Executor child activity is not collected or exposed", async (t) => {
	const { runtime, binding } = await fixture(t, "observer");
	assert.throws(() => runtime.observe(binding, () => {}), /executor/i);
	const turn = await runtime.send(binding, "work", { tokenAllowance: 100 });
	assert.equal(turn.output, "Hello 🌱!");
});

test("activity cannot be observed through a stale runtime binding", async (t) => {
	const { runtime, binding } = await fixture(t);
	assert.throws(() => runtime.observe({ ...binding, processMarker: "other" }, () => {}), /not attached/i);
});
