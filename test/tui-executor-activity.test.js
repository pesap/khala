import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, TuiAltScreen } from "@earendil-works/pi-tui";
import { showExecutorActivity } from "../dist/src/tui-executor-activity.js";
import { showWork } from "../dist/src/tui-work.js";

initTheme("dark");
const theme = { fg: (_color, text) => text, bold: (text) => text };
const turn = () => new Promise((resolve) => setImmediate(resolve));
let terminalRows = 32;

function renderScreen(component, columns, rows) {
	terminalRows = rows;
	let output = "";
	const terminal = { columns, rows, kittyProtocolActive: false,
		start() {}, stop() {}, drainInput: async () => {}, write: (data) => { output += data; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(component);
	tui.start();
	output = "";
	tui.renderNow(true);
	const lines = output.split("\u001b").filter((part) => !/^\[\?[\d;]*[hl]$/.test(part)).map((part) => stripTerminalSequences(`\u001b${part}`)).filter((line) => line.length > 0);
	tui.stop();
	return lines.join("\n");
}

function harness(actor = "user") {
	terminalRows = 32;
	const work = { workId: "work", state: "active", revision: 4, terms: { title: "Work", objective: "Do it." },
		nextAction: "Continue", execution: { executionId: "run", state: "running", pi: { sessionId: "private", sessionPath: "/private" } } };
	const screens = [];
	let snapshot = { state: "attached", entries: [], discarded: 0 };
	let notify;
	let observed = 0;
	let closed = 0;
	const service = {
		inspectWork: () => work,
		availableActions: () => [],
		observeExecutor: (workId, meta, callback) => {
			assert.equal(workId, work.workId);
			assert.equal(meta.actor, "user");
			assert.equal(meta.expectedWorkRevision, work.revision);
			observed += 1;
			notify = callback;
			return { snapshot: () => snapshot, close: () => { closed += 1; } };
		},
	};
	const context = { hasUI: true, mode: "tui", ui: { custom: (factory) => new Promise((resolve) => {
		const done = (value) => { component.dispose?.(); resolve(value); };
		const component = factory({ terminal: { get rows() { return terminalRows; } }, requestRender() {} }, theme, getKeybindings(), done);
		screens.push(component);
	}) } };
	const result = showWork(service, context, "work", actor, { comments: "ctrl+e" }, async () => {});
	return { result, screens, observed: () => observed, closed: () => closed,
		update: (value) => { snapshot = value; notify(); } };
}

test("Work opens live Executor activity only on demand and leaving never stops it", async () => {
	const h = harness();
	await turn();
	assert.equal(h.observed(), 0);
	assert.match(h.screens.at(-1).render(80).join("\n"), /Executor activity/);
	h.screens.at(-1).handleInput("\u001b[B");
	h.screens.at(-1).handleInput("\r");
	await turn();
	assert.equal(h.observed(), 1);
	const activity = h.screens.at(-1);
	assert.match(activity.render(80).join("\n"), /No activity observed/);
	h.update({ state: "attached", discarded: 0, entries: [
		{ kind: "message", text: "Inspecting code", truncated: false },
		{ kind: "tool", name: "read", callId: "call", phase: "started" },
	] });
	const live = activity.render(80).join("\n");
	assert.match(live, /Inspecting code/);
	assert.match(live, /read.*started/);
	assert.doesNotMatch(live, /sessionPath|private/);
	h.update({ state: "detached", entries: [], discarded: 0 });
	const detached = activity.render(80).join("\n");
	assert.match(detached, /detached/i);
	assert.doesNotMatch(detached, /Inspecting code/);
	activity.handleInput("\u001b");
	await turn();
	assert.equal(h.closed(), 1);
	h.screens.at(-1).handleInput("\u001b");
	assert.equal(await h.result, "back");
});

test("session status and incomplete history remain visible above a long feed on a small terminal", async () => {
	const h = harness();
	await turn();
	h.screens.at(-1).handleInput("\u001b[B");
	h.screens.at(-1).handleInput("\r");
	await turn();
	const activity = h.screens.at(-1);
	h.update({ state: "ended", discarded: 12, entries: Array.from({ length: 50 }, (_, index) =>
		({ kind: "message", text: `Entry ${index}`, truncated: false })) });
	const screen = renderScreen(activity, 40, 12);
	assert.match(screen, /ended/i);
	assert.match(screen, /incomplete/i);
	assert.match(screen, /discarded/i);
	assert.match(screen, /Entry 49/);
	activity.handleInput("\u001b");
	await turn();
	h.screens.at(-1).handleInput("\u001b");
	await h.result;
});

test("activity scroll hints follow configured Pi keybindings", async () => {
	const bindings = getKeybindings();
	const previous = bindings.getUserBindings();
	bindings.setUserBindings({ ...previous, "tui.editor.cursorUp": "alt+u", "tui.editor.cursorDown": "alt+d" });
	try {
		const h = harness();
		await turn();
		h.screens.at(-1).handleInput("\u001b[B");
		h.screens.at(-1).handleInput("\r");
		await turn();
		assert.match(h.screens.at(-1).render(100).join("\n"), /alt\+u\/alt\+d/);
		h.screens.at(-1).handleInput("\u001b");
		await turn();
		h.screens.at(-1).handleInput("\u001b");
		await h.result;
	} finally {
		bindings.setUserBindings(previous);
	}
});

test("initialization failure releases the observation and its timer", async () => {
	const setIntervalBefore = globalThis.setInterval;
	const clearIntervalBefore = globalThis.clearInterval;
	const timer = { unref() {} };
	let cleared = 0;
	let closed = 0;
	globalThis.setInterval = () => timer;
	globalThis.clearInterval = (value) => { if (value === timer) cleared += 1; };
	try {
		const service = { observeExecutor: () => ({ snapshot: () => ({ state: "attached", entries: [], discarded: 0 }), close: () => { closed += 1; } }) };
		const context = { ui: { custom: async (factory) => factory({ requestRender() { throw new Error("render failed"); } }, theme, getKeybindings(), () => {}) } };
		await assert.rejects(showExecutorActivity(service, context, { workId: "work", revision: 1 }), /render failed/);
		assert.equal(closed, 1);
		assert.equal(cleared, 1);
	} finally {
		globalThis.setInterval = setIntervalBefore;
		globalThis.clearInterval = clearIntervalBefore;
	}
});

test("non-user roles cannot open the User's Executor activity panel", async () => {
	const h = harness("executor");
	await turn();
	assert.doesNotMatch(h.screens.at(-1).render(80).join("\n"), /Executor activity/);
	assert.equal(h.observed(), 0);
	h.screens.at(-1).handleInput("\u001b");
	assert.equal(await h.result, "back");
});
