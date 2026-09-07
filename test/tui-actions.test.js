import assert from "node:assert/strict";
import { test } from "node:test";
import { createActionRunner } from "../dist/src/tui-actions.js";

function setup(choices, edits = []) {
	const performed = [];
	const initialScreens = [];
	const errors = [];
	const ui = {
		select: async () => choices.shift(),
		setEditorText: () => { throw new Error("Must not touch the User editor"); },
		getEditorText: () => { throw new Error("Must not read the User editor"); },
		confirm: async () => true,
		notify: (message) => errors.push(message),
		custom: (factory) => new Promise((resolve) => {
			const theme = { fg: (_color, text) => text };
			const component = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, {}, resolve);
			initialScreens.push(component.render(80).join("\n"));
			const text = edits.shift();
			if (text !== undefined) component.handleInput(`\u001b[200~${text}\u001b[201~`);
			component.handleInput("\u001b");
		}),
	};
	const service = {
		perform: async (command) => { performed.push(command); return { value: { nextAction: "done" } }; },
		processPendingEffects: async () => {},
	};
	return { context: { ui }, service, performed, initialScreens, errors };
}

const work = { workId: "w1", revision: 1 };
const action = { id: "a1", scope: "work", kind: "record-review", label: "Review", enabled: true };

test("Escape saves a multiline draft without submitting or touching the User editor", async () => {
	const feedback = " first\n\n  second\n";
	const choices = ["Edit", "changes-requested", "Back"];
	const fake = setup(choices, [feedback]);
	const run = createActionRunner(fake.service, fake.context, "user");
	await run(work, action);
	assert.equal(fake.performed.length, 0);
	choices.push("Submit");
	await run(work, action);
	assert.deepEqual(fake.performed[0].input.feedback, [feedback]);
});

test("closing the action menu is not implicit Submit", async () => {
	const fake = setup(["Edit", "merged", undefined], ["feedback"]);
	await createActionRunner(fake.service, fake.context, "user")(work, action);
	assert.equal(fake.performed.length, 0);
});

test("a revision conflict retains the draft for explicit submission at the new revision", async () => {
	const choices = ["Edit", "changes-requested", "Submit"];
	const fake = setup(choices, ["keep\n\n  indentation"]);
	let attempts = 0;
	fake.service.perform = async (command) => {
		fake.performed.push(command);
		return attempts++ === 0 ? { error: { code: "revision-conflict", summary: "Changed", remediation: "Reread" } } : { value: { nextAction: "done" } };
	};
	const run = createActionRunner(fake.service, fake.context, "user");
	await run(work, action);
	assert.equal(fake.performed.length, 1);
	choices.push("Submit");
	await run({ ...work, revision: 2 }, action);
	assert.deepEqual(fake.performed[1].input, fake.performed[0].input);
	assert.equal(fake.performed[1].meta.expectedWorkRevision, 2);
	assert.notEqual(fake.performed[1].meta.commandId, fake.performed[0].meta.commandId);
});

test("an unknown mutation outcome retries exactly the original command", async () => {
	const choices = ["Edit", "changes-requested", "Submit"];
	const fake = setup(choices, ["keep"]);
	let attempts = 0;
	fake.service.perform = async (command) => {
		fake.performed.push(command);
		if (attempts++ === 0) throw new Error("response disconnected");
		return { value: { nextAction: "done" } };
	};
	const run = createActionRunner(fake.service, fake.context, "user");
	await run(work, action);
	choices.push("Retry pending command");
	await run({ ...work, revision: 2 }, action);
	assert.deepEqual(fake.performed[1], fake.performed[0]);
});

test("discard removes a saved draft and consequential denial performs nothing", async () => {
	const choices = ["Edit", "changes-requested", "Discard", "Edit", "merged", "Back"];
	const fake = setup(choices, ["discard me", undefined]);
	const run = createActionRunner(fake.service, fake.context, "user");
	await run(work, action);
	await run(work, action);
	assert.doesNotMatch(fake.initialScreens[1], /discard me/);
	choices.push("Submit");
	fake.context.ui.confirm = async () => false;
	await run(work, { ...action, kind: "fail-work" });
	assert.equal(fake.performed.length, 0);
});
