import assert from "node:assert/strict";
import { test } from "node:test";
import { showKhalaArchive } from "../dist/src/index.js";

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
		terms: { title: "Completed demo Work" },
		budget: { maxTokens: 1000, reservedTokens: 0, consumedTokens: 0 },
		execution: { state: "completed" },
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
		readRecords: () => ({
			items: [
				{
					sequence: 1,
					recordNumber: 1,
					id: "record-1",
					kind: "submission",
					actor: "user",
					workId: work.workId,
					payloadVersion: 1,
					summary: "Completed demo Work submitted",
					evidenceRefs: [],
					recordedAt: "2026-01-01T00:00:00.000Z",
					payload: {},
				},
			],
			asOfSequence: 1,
		}),
		close() {},
	};
	const context = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					const done = (value) => resolve(value);
					screens.push(factory({ requestRender() {} }, theme, {}, done));
				}),
		},
	};

	const result = showKhalaArchive(archive, context, { includeHistory: true });
	await nextTurn();
	const picker = screens[0].render(100).join("\n");
	assert.match(picker, /Completed demo Work/);
	assert.match(picker, /succeeded\s+completed/);
	screens[0].handleInput("\r");
	await nextTurn();
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /Completed demo Work/);
	assert.match(overview, /Archive/);
	assert.match(overview, /Evidence/);
	assert.doesNotMatch(overview, /Actions/);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
});
