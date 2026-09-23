import assert from "node:assert/strict";
import { test } from "node:test";
import { showKhalaArchive } from "../dist/src/index.js";
import { tuiKeybindings } from "./helpers/tui-fixtures.mjs";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("read-only Khala archive display includes history without lifecycle actions", async () => {
	const screens = [];
	const work = {
		workId: "demo-succeeded",
		state: "succeeded",
		revision: 2,
		terms: { title: "Completed demo Work", maxTokens: 1000 },
		budget: { maxTokens: 1000, reservedTokens: 20, consumedTokens: 970 },
		activeInvocations: [{ runId: "held-run", role: "oracle", allowance: 30, state: "uncertain" }],
		dispatchLimits: { maxCorrections: 3 },
		correctionCount: 1,
		execution: {
			state: "completed",
			tokenAllowance: 50,
			usage: { inputTokens: 30, outputTokens: 15, cacheHitTokens: 100, cacheMissTokens: 40 },
		},
		nextAction: "No action is needed.",
	};
	const summary = {
		workId: work.workId,
		title: work.terms.title,
		state: work.state,
		executionState: "completed",
		nextAction: work.nextAction,
	};
	const archive = {
		listWork: () => [summary],
		inspectWork: () => work,
		close() {},
	};
	const context = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					const done = (value) => resolve(value);
					screens.push(factory({ requestRender() {} }, theme, tuiKeybindings, done));
				}),
		},
	};

	const result = showKhalaArchive(archive, context);
	await nextTurn();
	const picker = screens[0].render(100).join("\n");
	assert.match(picker, /Completed demo Work/);
	assert.match(picker, /succeeded\s+completed/);
	screens[0].handleInput("\r");
	await nextTurn();
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /Completed demo Work/);
	assert.match(overview, /Execution/);
	assert.match(overview, /Token cap\s+1000/);
	assert.match(overview, /Consumed input \+ output\s+970/);
	assert.match(overview, /Held reservations\s+20/);
	assert.match(overview, /Available tokens\s+10/);
	assert.match(overview, /Work dispatch\s+eligible: Work budget and\s+preparation permit dispatch/);
	assert.match(overview, /Execution token allowance\s+50/);
	assert.match(overview, /Execution consumed input \+ output\s+45/);
	assert.match(overview, /Execution tokens remaining\s+5/);
	assert.match(overview, /Correction attempts\s+1 of 3 used; 2 remaining/);
	assert.match(overview, /Replacement eligibility \(correction and Work dispatch gates\)\s+pass: Current correction,\s+Work-token/u);
	assert.match(overview, /oracle uncertain reservation held-run\s+30 allowance; usage reconciliation\s+pending/);
	assert.doesNotMatch(overview, /Actions/);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
});
