import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDescriptor } from "../dist/src/service-action-catalog.js";
import { createActionRunner } from "../dist/src/tui-actions.js";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const turn = () => new Promise((resolve) => setImmediate(resolve));
const work = {
	workId: "w1",
	revision: 7,
	terms: {
		title: "Work",
		objective: "Objective",
		context: "Context",
		scope: "Scope",
		acceptanceCriteria: [],
		constraints: [],
		validation: [],
		allowedPaths: [],
		maxTokens: 100,
	},
};

function makeAction(kind, currentWork = work) {
	return {
		id: `action-${kind}`,
		scope: "work",
		kind,
		enabled: true,
		expectedWorkRevision: currentWork.revision,
		...actionDescriptor(kind, currentWork),
	};
}

function setup(edits = [], choices = []) {
	const screens = [];
	const performed = [];
	const editorCalls = [];
	const confirmations = [];
	const notices = [];
	const ui = {
		select: async (title, options) => {
			const choice = choices.shift();
			return choice === undefined ? options[0] : choice;
		},
		setEditorText: () => {
			throw new Error("Must not touch the User editor");
		},
		getEditorText: () => {
			throw new Error("Must not read the User editor");
		},
		confirm: async (title, message) => {
			confirmations.push({ title, message });
			return true;
		},
		notify: (message) => notices.push(message),
		editor: async (title, prefill) => {
			editorCalls.push({ title, prefill });
			return edits.shift();
		},
		custom: (factory) =>
			new Promise((resolve) => {
				screens.push(factory({ requestRender() {} }, theme, {}, resolve));
			}),
	};
	const service = {
		perform: async (command) => {
			performed.push(command);
			return { value: { nextAction: "done" } };
		},
		processPendingEffects: async () => {},
	};
	return { context: { ui }, service, screens, performed, editorCalls, confirmations, notices };
}

/** Every edit, confirmation, and submission reopens the panel, so assertions read the newest screen. */
function view(fake) {
	return fake.screens.at(-1).render(100).join("\n");
}

async function press(fake, data) {
	fake.screens.at(-1).handleInput(data);
	await turn();
}

async function choose(fake, label) {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const selected = view(fake)
			.split("\n")
			.some((line) => line.trimStart().startsWith(`→ ${label}`));
		if (selected) return press(fake, "\r");
		await press(fake, "\u001b[B");
	}
	assert.fail(`Could not select ${label} in:\n${view(fake)}`);
}

async function leave(fake, pending) {
	await press(fake, "\u001b");
	await pending;
}

test("zero-input retry admission shows its effect and submits an empty input", async () => {
	const fake = setup();
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("retry-admission"));
	await turn();
	assert.match(view(fake), /Effect\s+Clears the recorded admission failure/);
	assert.match(view(fake), /→ Retry admission\s+Sends this action to Khala/);
	assert.doesNotMatch(view(fake), /Discard draft values/);
	await press(fake, "\r");
	await pending;
	assert.equal(fake.editorCalls.length, 0);
	assert.deepEqual(fake.performed[0].input, {});
	assert.equal(fake.performed[0].meta.expectedWorkRevision, 7);
});

test("a required field blocks submission and repeats its reason on the submit row", async () => {
	const fake = setup();
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("fail-work"));
	await turn();
	assert.match(view(fake), /Requires\s+Reason is required\./);
	assert.match(view(fake), /Submit\s+Reason is required\./);
	await choose(fake, "Submit");
	assert.equal(fake.performed.length, 0);
	assert.equal(fake.screens.length, 1);
	await leave(fake, pending);
});

test("filling a required field clears the requirement and confirms the service consequence", async () => {
	const reason = "The requirement was withdrawn.";
	const fake = setup([reason]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("fail-work"));
	await turn();
	await choose(fake, "Reason *");
	assert.equal(fake.editorCalls[0].title, "Reason");
	assert.equal(fake.editorCalls[0].prefill, undefined);
	assert.match(view(fake), /Reason \*\s+The requirement was withdrawn\./);
	assert.doesNotMatch(view(fake), /Requires\s/);
	await choose(fake, "Mark as failed");
	await pending;
	assert.equal(fake.confirmations.length, 1);
	assert.match(fake.confirmations[0].message, /prevents recovery/);
	assert.match(fake.confirmations[0].message, /Reason: not set -> The requirement was withdrawn\./);
	assert.deepEqual(fake.performed[0].input, { reason });
});

test("a multiline text value with blank lines and leading spaces survives submission", async () => {
	const reason = " first line\n\n  second line\n";
	const fake = setup([reason]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("fail-work"));
	await turn();
	await choose(fake, "Reason *");
	await choose(fake, "Mark as failed");
	await pending;
	assert.equal(fake.performed[0].input.reason, reason);
});

test("lines fields split on non-blank lines while preserving their text", async () => {
	const feedback = "First paragraph.\n\n  Second paragraph.";
	const fake = setup([feedback], ["Changes requested - Returns the Work to the Executor with feedback."]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("record-review"));
	await turn();
	await choose(fake, "Review result *");
	await choose(fake, "Review feedback");
	await choose(fake, "Record review");
	await pending;
	assert.deepEqual(fake.performed[0].input.feedback, ["First paragraph.", "  Second paragraph."]);
});

test("record review requires feedback for changes requested but not for a merged review", async () => {
	const fake = setup([], ["Changes requested - Returns the Work to the Executor with feedback."]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("record-review"));
	await turn();
	await choose(fake, "Review result *");
	assert.match(view(fake), /Requires\s+Review feedback is required when Review result is changes-requested\./);
	await choose(fake, "Submit");
	assert.equal(fake.performed.length, 0);
	await leave(fake, pending);

	const merged = setup([], ["Merged - Accepts the change; the Conclave settles the Outcome."]);
	const second = createActionRunner(merged.service, merged.context, "user")(work, makeAction("record-review"));
	await turn();
	await choose(merged, "Review result *");
	await choose(merged, "Record review");
	await second;
	assert.deepEqual(merged.performed[0].input, { status: "merged" });
});

test("a bad integer blocks amendment with the minimum whole-number reason", async () => {
	const fake = setup(["not-a-number"]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("amend-budget"));
	await turn();
	await choose(fake, "Token cap *");
	assert.match(view(fake), /Requires\s+Token cap must be a whole number of 1 or more\./);
	await choose(fake, "Submit");
	assert.equal(fake.performed.length, 0);
	await leave(fake, pending);
});

test("a recorded value prefills its editor and the confirmation shows the change", async () => {
	const fake = setup(["40000"]);
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("amend-budget"));
	await turn();
	assert.match(view(fake), /Token cap \*\s+unchanged: 100/);
	await choose(fake, "Token cap *");
	assert.equal(fake.editorCalls[0].prefill, "100");
	await choose(fake, "Amend budget");
	await pending;
	assert.match(fake.confirmations[0].message, /Token cap: 100 -> 40000/);
	assert.deepEqual(fake.performed[0].input, { maxTokens: 40000 });
});

test("denied confirmation performs nothing and keeps the draft", async () => {
	const reason = "Keep the Work for later review.";
	const fake = setup([reason]);
	fake.context.ui.confirm = async () => false;
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("fail-work"));
	await turn();
	await choose(fake, "Reason *");
	await choose(fake, "Mark as failed");
	assert.equal(fake.performed.length, 0);
	assert.match(view(fake), /Reason \*\s+Keep the Work for later review\./);
	await leave(fake, pending);
});

test("a rejected command shows its outcome and resubmits the retained draft at a new revision", async () => {
	const scope = "Only change the greeting file.";
	const fake = setup([scope]);
	let attempts = 0;
	fake.service.perform = async (command) => {
		fake.performed.push(command);
		return attempts++ === 0
			? {
					error: {
						code: "revision-conflict",
						summary: "The Work changed.",
						remediation: "Reread the Work before retrying.",
					},
				}
			: { value: { nextAction: "done" } };
	};
	const run = createActionRunner(fake.service, fake.context, "user");
	const pending = run(work, makeAction("amend-terms"));
	await turn();
	await choose(fake, "Scope");
	await choose(fake, "Amend terms");
	assert.match(view(fake), /Outcome\s+revision-conflict: The Work changed\./);
	assert.match(view(fake), /Remediation\s+Reread the Work before retrying\./);
	assert.match(view(fake), /Scope\s+Only change the greeting file\./);
	await leave(fake, pending);

	const amended = { ...work, revision: 8 };
	const second = run(amended, makeAction("amend-terms", amended));
	await turn();
	await choose(fake, "Amend terms");
	await second;
	assert.deepEqual(fake.performed[1].input, fake.performed[0].input);
	assert.notEqual(fake.performed[1].meta.commandId, fake.performed[0].meta.commandId);
	assert.equal(fake.performed[1].meta.expectedWorkRevision, 8);
});

test("an unknown outcome shows the pending command and retries it identically", async () => {
	const fake = setup([], ["Merged - Accepts the change; the Conclave settles the Outcome."]);
	let attempts = 0;
	fake.service.perform = async (command) => {
		fake.performed.push(command);
		if (attempts++ === 0) throw new Error("response disconnected");
		return { value: { nextAction: "done" } };
	};
	const pending = createActionRunner(fake.service, fake.context, "user")(work, makeAction("record-review"));
	await turn();
	await choose(fake, "Review result *");
	await choose(fake, "Record review");
	assert.match(view(fake), /Pending\s+Command .* at revision 7 reported no outcome; fields are locked\s+until retry/);
	assert.match(view(fake), /Outcome\s+external-failure: response disconnected/);
	assert.doesNotMatch(view(fake), /Discard draft values/);
	await choose(fake, "Retry pending command");
	await pending;
	assert.deepEqual(fake.performed[1], fake.performed[0]);
});

test("discard draft values removes the value and its editor prefill", async () => {
	const fake = setup(["discard me", undefined]);
	const run = createActionRunner(fake.service, fake.context, "user");
	const pending = run(work, makeAction("fail-work"));
	await turn();
	await choose(fake, "Reason *");
	await choose(fake, "Discard draft values");
	await pending;
	assert.equal(fake.performed.length, 0);

	const second = run(work, makeAction("fail-work"));
	await turn();
	assert.match(view(fake), /Reason \*\s+not set/);
	await choose(fake, "Reason *");
	assert.equal(fake.editorCalls[1].prefill, undefined);
	await leave(fake, second);
});

test("held usage reconciliation uses the Work invocation and nests its usage input", async () => {
	const heldWork = {
		...work,
		activeInvocations: [{ runId: "run-1", role: "executor", state: "uncertain", allowance: 100 }],
	};
	const fake = setup(
		["12", "8", "3", "9", "provider receipt 42"],
		["executor run-1 - uncertain reservation of 100 tokens"],
	);
	const pending = createActionRunner(fake.service, fake.context, "user")(
		heldWork,
		makeAction("reconcile-invocation", heldWork),
	);
	await turn();
	await choose(fake, "Held invocation *");
	for (const field of [
		"Cumulative input tokens *",
		"Cumulative output tokens *",
		"Cumulative cache hit tokens *",
		"Cumulative cache miss tokens *",
		"Usage evidence *",
	]) {
		await choose(fake, field);
	}
	await choose(fake, "Reconcile held usage");
	await pending;
	assert.equal(fake.confirmations.length, 1);
	assert.match(fake.confirmations[0].message, /Estimated counts corrupt the Work budget permanently\./);
	assert.deepEqual(fake.performed[0].input, {
		runId: "run-1",
		usage: { inputTokens: 12, outputTokens: 8, cacheHitTokens: 3, cacheMissTokens: 9 },
		evidence: ["provider receipt 42"],
	});
});
