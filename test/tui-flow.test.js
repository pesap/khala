import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { showKhala } from "../dist/src/tui.js";

initTheme("dark");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const turn = () => new Promise((resolve) => setImmediate(resolve));
function renderScreen(component, columns, rows) {
	let output = "";
	const terminal = {
		columns, rows, kittyProtocolActive: false,
		start() {}, stop() {}, drainInput: async () => {},
		write: (data) => { output += data; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
		clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
	};
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(component);
	tui.start();
	output = "";
	tui.renderNow(true);
	const lines = output.split("\u001b").filter((part) => !/^\[\?[\d;]*[hl]$/.test(part)).map((part) => stripTerminalSequences(`\u001b${part}`)).filter((line) => line.length > 0);
	tui.stop();
	return lines;
}
const work = {
	workId: "work", state: "active", revision: 4,
	terms: { title: "Example", objective: "Deliver the documented behavior. ".repeat(12) },
	nextAction: "Inspect the result", budget: { maxTokens: 100, consumedTokens: 0, reservedTokens: 0 },
};
function harness(overrides = {}) {
	const screens = [];
	const notices = [];
	const reads = [];
	const menus = [];
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, nextAction: work.nextAction }],
		inspectWork: () => work,
		inspectRuntime: () => { throw new Error("Opening must not probe runtime"); },
		readRecords: (query, meta, cursor) => { reads.push({ query, meta, cursor }); return { items: [], asOfSequence: 0 }; },
		availableActions: () => [],
		...overrides,
	};
	const context = { hasUI: true, mode: "tui", ui: {
		notify: (message) => notices.push(message),
		select: async (title, choices) => { menus.push({ title, choices }); return undefined; },
		custom: (factory) => new Promise((resolve) => {
			const done = (value) => { component.dispose?.(); resolve(value); };
			const component = factory({ requestRender() {} }, theme, {}, done);
			screens.push(component);
		}),
	} };
	return { screens, notices, reads, menus, result: showKhala(service, context) };
}

async function close(h) {
	h.screens.at(-1).handleInput("\u001b");
	await turn();
	h.screens.at(-1).handleInput("\u001b");
	await h.result;
}

test("opening saved Work is lazy and short-terminal overview keeps controls reachable after resize", async () => {
	const h = harness();
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	assert.equal(h.reads.length, 0);
	const overview = h.screens.at(-1);
	for (const [width, height] of [[80, 24], [40, 12], [80, 24]]) {
		const lines = renderScreen(overview, width, height);
		assert.ok(lines.length <= height + 1);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), JSON.stringify(lines));
		assert.match(lines.join("\n"), /Actions/);
		assert.match(lines.join("\n"), /escape/);
	}
	const before = renderScreen(overview, 40, 12).join("\n");
	overview.handleInput("\u001b[6~");
	const after = renderScreen(overview, 40, 12).join("\n");
	assert.notEqual(after, before);
	assert.match(after, /Actions/);
	await close(h);
});

test("Work overview nests actions and separates the summary from navigation", async () => {
	const h = harness({ availableActions: () => [{ id: "cancel", kind: "cancel", label: "Cancel Work", enabled: true }] });
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	const overview = h.screens.at(-1);
	const lines = overview.render(80);
	assert.doesNotMatch(lines.join("\n"), /→ Cancel\b/);
	assert.match(lines.join("\n"), /Summary\s+Deliver the documented behavior\./);
	assert.doesNotMatch(lines.join("\n"), /Goal/);
	const summaryEnd = lines.findIndex((line) => line.includes("Freshness"));
	const navigationStart = lines.findIndex((line) => line.includes("→ Actions"));
	assert.ok(summaryEnd >= 0 && navigationStart > summaryEnd + 1, JSON.stringify(lines));
	assert.ok(lines.slice(summaryEnd + 1, navigationStart).some((line) => line.trim().length === 0), JSON.stringify(lines));
	assert.equal(lines.filter((line) => line.includes("Deliver the documented behavior.")).length, 1);
	overview.handleInput("\r");
	await turn();
	assert.match(h.screens.at(-1).render(80).join("\n"), /→ Refresh runtime\b/);
	h.screens.at(-1).handleInput("\u007f");
	await turn();
	h.screens.at(-1).handleInput("\u007f");
	await turn();
	h.screens.at(-1).handleInput("\u007f");
	await h.result;
});

test("enabled actions are nested under the Actions section", async () => {
	const h = harness({ availableActions: () => [{ id: "cancel", kind: "cancel", label: "Cancel Work", enabled: true }] });
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	const overview = h.screens.at(-1);
	assert.doesNotMatch(renderScreen(overview, 40, 12).join("\n"), /→ Cancel/);
	overview.handleInput("\r");
	await turn();
	const actions = h.screens.at(-1);
	assert.match(renderScreen(actions, 40, 12).join("\n"), /→ Refresh runtime/);
	actions.handleInput("\u001b[B");
	assert.match(renderScreen(actions, 40, 12).join("\n"), /→ Cancel/);
	actions.handleInput("\r");
	await turn();
	assert.match(h.menus[0].title, /Cancel Work/);
	assert.ok(h.menus[0].choices.includes("Submit"));
	assert.equal(h.reads.length, 0);
	await close(h);
});

test("Work filters separate attention, review and terminal history without loading record bodies", async () => {
	const items = [
		{ workId: "a", title: "Normal task", state: "active" },
		{ workId: "b", title: "Clarify task", state: "needs-input" },
		{ workId: "c", title: "Review task", state: "awaiting-review" },
		{ workId: "d", title: "Completed task", state: "succeeded" },
	];
	const h = harness({ listWork: () => items });
	await turn();
	const picker = h.screens[0];
	picker.handleInput("\u001b[C");
	assert.match(picker.render(100).join("\n"), /Needs attention/);
	assert.match(picker.render(100).join("\n"), /Clarify task/);
	assert.doesNotMatch(picker.render(100).join("\n"), /Normal task|Review task|Completed task/);
	picker.handleInput("\u001b[C");
	assert.match(picker.render(100).join("\n"), /Review task/);
	assert.doesNotMatch(picker.render(100).join("\n"), /Clarify task/);
	picker.handleInput("\u001b[C");
	assert.match(picker.render(100).join("\n"), /Completed task/);
	assert.doesNotMatch(picker.render(100).join("\n"), /Normal task|Review task/);
	assert.equal(h.reads.length, 0);
	picker.handleInput("\u001b[C");
	assert.match(picker.render(100).join("\n"), /→\s+Normal task/);
	picker.handleInput("\u001b");
	await h.result;
});

test("explicit runtime refresh supplies the next overview and available actions", async () => {
	const states = [];
	const refreshed = { ...work, execution: { executionId: "execution", state: "running", runtimeState: "unreachable" } };
	const h = harness({
		inspectRuntime: async () => refreshed,
		availableActions: (_id, _actor, _revision, runtimeState) => { states.push(runtimeState); return []; },
	});
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	const overview = h.screens.at(-1);
	overview.handleInput("\r");
	await turn();
	const actions = h.screens.at(-1);
	assert.match(actions.render(100).join("\n"), /Refresh runtime/);
	actions.handleInput("\r");
	await turn();
	assert.match(h.screens.at(-1).render(100).join("\n"), /Runtime checked/);
	h.screens.at(-1).handleInput("\u001b");
	await turn();
	const refreshedOverview = h.screens.at(-1);
	assert.match(refreshedOverview.render(100).join("\n"), /unreachable/);
	refreshedOverview.handleInput("\r");
	await turn();
	assert.equal(states.at(-1), "unreachable");
	h.screens.at(-1).handleInput("\u007f");
	await turn();
	await close(h);
});

test("dismissed recovery cannot be started again while the original operation is pending", async () => {
	let resolveRecovery;
	let calls = 0;
	const h = harness({
		availableActions: () => [{ id: "recover", kind: "recover", label: "Recover", enabled: true }],
		perform: () => { calls += 1; return new Promise((resolve) => { resolveRecovery = resolve; }); },
		processPendingEffects: async () => {},
	});
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	h.screens.at(-1).handleInput("\r");
	await turn();
	h.screens.at(-1).handleInput("\r");
	await turn();
	assert.equal(calls, 1);
	h.screens.at(-1).handleInput("\u001b");
	await turn();
	h.screens.at(-1).handleInput("\r");
	await turn();
	h.screens.at(-1).handleInput("\r");
	await turn();
	assert.equal(calls, 1);
	assert.match(h.notices[0], /already in progress/);
	resolveRecovery({ value: work });
	await turn();
	await close(h);
});

test("an empty Evidence page retains navigation to older relevant records", async () => {
	const cursors = [];
	const record = (sequence, evidenceRefs) => ({ sequence, recordNumber: sequence, id: `r${sequence}`, kind: "submission", actor: "user", summary: `Evidence record ${sequence}`, recordedAt: "2026-01-01T00:00:00Z", evidenceRefs, payload: {} });
	const h = harness({ readRecords: (_query, _meta, cursor) => {
		cursors.push(cursor);
		return cursor === undefined
			? { items: [record(200, [])], nextCursor: "older", asOfSequence: 200 }
			: { items: [record(100, ["relevant proof"])], asOfSequence: 200 };
	} });
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	h.screens.at(-1).handleInput("\u001b[B");
	h.screens.at(-1).handleInput("\r");
	await turn();
	assert.match(h.screens.at(-1).render(100).join("\n"), /Older/);
	h.screens.at(-1).handleInput("\u001b[D");
	await turn();
	assert.deepEqual(cursors, [undefined, "older"]);
	assert.match(h.screens.at(-1).render(100).join("\n"), /Evidence record 100/);
	h.screens.at(-1).handleInput("\u001b");
	await turn();
	await close(h);
});

test("Archive reads one newest-first page at a time and retains the page when continuation fails", async () => {
	const reads = [];
	const record = (sequence) => ({ sequence, recordNumber: sequence, id: `r${sequence}`, kind: "submission", actor: "user", summary: `Saved record ${sequence}`, recordedAt: "2026-01-01T00:00:00Z", payload: {} });
	const h = harness({ readRecords: (query, meta, cursor) => {
		reads.push({ query, meta, cursor });
		if (cursor !== undefined) throw new Error("Disconnected");
		return { items: [record(200), record(199)], nextCursor: "older-page", asOfSequence: 200 };
	} });
	await turn();
	h.screens[0].handleInput("\r");
	await turn();
	assert.equal(reads.length, 0);
	h.screens.at(-1).handleInput("\u001b[B");
	h.screens.at(-1).handleInput("\u001b[B");
	h.screens.at(-1).handleInput("\r");
	await turn();
	assert.equal(reads.length, 1);
	assert.equal(reads[0].query.order, "desc");
	assert.match(h.screens.at(-1).render(100).join("\n"), /Saved record 200/);
	h.screens.at(-1).handleInput("\u001b[D");
	await turn();
	assert.equal(reads.length, 2);
	assert.equal(reads[1].cursor, "older-page");
	assert.match(h.notices[0], /Disconnected/);
	assert.match(h.screens.at(-1).render(100).join("\n"), /Saved record 200/);
	h.screens.at(-1).handleInput("\u001b");
	await turn();
	await close(h);
});
