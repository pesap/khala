import assert from "node:assert/strict";
import { test } from "node:test";
import { InvocationSteering } from "../dist/src/invocation-steering.js";

test("steering remains invocation-local, bounded, and immutable to callers", () => {
	const steering = new InvocationSteering();
	for (let index = 0; index < 200; index += 1) steering.enqueue(`message ${index}`);
	assert.throws(() => steering.enqueue("overflow"), /queue is full/i);
	const queued = steering.pending();
	assert.equal(queued.length, 200);
	queued[0].text = "changed by caller";
	assert.equal(steering.pending()[0].text, "message 0");
	steering.markInserted([queued[0].id]);
	steering.enqueue("another message");
	assert.equal(steering.snapshot().length, 200);
	steering.close();
	steering.markInserted([queued[1].id]);
	assert.ok(steering.snapshot().every(({ status }) => status === "not-inserted"));
	assert.throws(() => steering.enqueue("late"), /settled/i);
	const replacement = new InvocationSteering();
	assert.deepEqual(replacement.pending(), []);
});

test("aborted or invalidated invocations discard pending guidance without replay", () => {
	const controller = new AbortController();
	let allowed = true;
	const steering = new InvocationSteering(() => allowed, controller.signal);
	steering.enqueue("not for a replacement");
	allowed = false;
	assert.equal(steering.snapshot()[0].status, "not-inserted");
	assert.deepEqual(steering.pending(), []);
	const aborted = new InvocationSteering(() => true, controller.signal);
	controller.abort();
	assert.throws(() => aborted.enqueue("after cancellation"), /settled/i);
});
