import assert from "node:assert/strict";
import { test } from "node:test";
import reviewExtension from "../dist/extensions/pi-review/review.js";

function createHarness({ args, selection, editedPaths } = {}) {
	const commands = new Map();
	const events = new Map();
	const messages = [];
	const entries = [];
	const notifications = [];
	const pi = {
		registerCommand(name, command) {
			commands.set(name, command);
		},
		on(name, handler) {
			events.set(name, handler);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		sendUserMessage(message) {
			messages.push(message);
		},
	};
	const context = {
		hasUI: true,
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => [] },
		ui: {
			select: async () => selection,
			editor: async () => editedPaths,
			setWidget() {},
			notify: (message) => notifications.push(message),
		},
	};
	reviewExtension(pi);
	void events.get("session_start")?.({}, context);
	return {
		commands,
		context,
		messages,
		notifications,
		start: (value = args) => commands.get("review").handler(value, context),
	};
}

test("snapshot reviews allow concrete problems in the snapshot without a change baseline", async () => {
	const harness = createHarness({ selection: "Review files or folders", editedPaths: "src/a.ts" });
	await harness.start();
	assert.match(harness.messages[0], /snapshot of:/);
	assert.match(harness.messages[0], /concrete problems present in the snapshot/i);
	assert.doesNotMatch(harness.messages[0], /introduced by the change/);
	assert.match(harness.messages[0], /exact path and line, concrete impact, evidence, and a fix direction/);
	assert.match(harness.messages[0], /No findings is an acceptable result/);
	assert.match(harness.messages[0], /Do not edit files, commit, push, or claim acceptance/);
});

test("diff reviews remain limited to actionable findings introduced by the change", async () => {
	const harness = createHarness({ selection: "Review against a base branch", editedPaths: undefined });
	harness.context.ui.input = async () => "main";
	await harness.start();
	assert.match(harness.messages[0], /introduced by the requested change/i);
});

test("direct-text targets use the shared review contract", async () => {
	const harness = createHarness();
	await harness.start("snapshot of: src/a.ts");
	assert.match(harness.messages[0], /snapshot of: src\/a\.ts/);
	assert.match(harness.messages[0], /concrete problems present in the snapshot/i);
});

test("cancelling the selector starts no review", async () => {
	const harness = createHarness({ selection: undefined });
	await harness.start();
	assert.deepEqual(harness.messages, []);
	assert.deepEqual(harness.notifications, []);
});
