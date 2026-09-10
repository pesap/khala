import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { showKhala } from "../dist/src/tui.js";
import { theme, nextTurn } from "./helpers/tui-fixtures.mjs";

test("Role settings open with r, show a comparison table, and use the native model selector", async () => {
	initTheme();
	const screens = [];
	const selections = ["Model: provider/conclave", "Thinking: medium", "low"];
	const userSettings = Object.freeze({ defaultModel: "provider/conclave" });
	const settings = {
		conclave: { model: "provider/conclave", thinking: "medium" },
		executor: { model: "provider/executor", thinking: "high" },
		observer: { model: "provider/observer", thinking: "medium" },
		oracle: { model: "provider/oracle", thinking: "high" },
	};
	const updates = [];
	const controller = {
		get: () => settings,
		set: (role, setting, value) => {
			settings[role][setting] = value;
			updates.push({ role, setting, value });
		},
	};
	const service = { listWork: () => [] };
	const models = [
		{ provider: "provider", id: "fallback", name: "Fallback model" },
		{ provider: "provider", id: "conclave", name: "Conclave model" },
	];
	const keybindings = {
		matches: (data, action) => ({
			"tui.input.tab": "\t",
			"tui.select.up": "\u001b[A",
			"tui.select.down": "\u001b[B",
			"tui.select.confirm": "\r",
			"tui.select.cancel": "\u001b",
		}[action] === data),
	};
	const context = {
		hasUI: true,
		mode: "tui",
		scopedModels: [{ model: models[1] }],
		modelRegistry: {
			getAvailable: () => models,
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			getError: () => undefined,
			refresh: async () => ({ aborted: false, errors: new Map() }),
		},
		ui: {
			notify: () => {},
			onTerminalInput: () => () => {},
			select: async () => selections.shift(),
			custom: (factory) =>
				new Promise((resolve) => {
					const done = (value) => resolve(value);
					screens.push(factory({ requestRender() {} }, theme, keybindings, done));
				}),
		},
	};
	const result = showKhala(service, context, "user", undefined, controller);
	await nextTurn();
	assert.doesNotMatch(screens[0].render(100).join("\n"), /→ Role settings/);
	screens[0].handleInput("r");
	await nextTurn();
	const roleTable = screens[1].render(100).join("\n");
	assert.match(roleTable, /ROLE\s+MODEL\s+THINKING/);
	assert.match(roleTable, /Conclave\s+provider\/conclave\s+medium/);
	assert.doesNotMatch(roleTable, /Conclave:/);
	screens[1].handleInput("\r");
	await nextTurn();
	await nextTurn();
	assert.match(screens[2].render(100).join("\n"), /Model Name: Conclave model/);
	assert.match(screens[2].render(100).join("\n"), /Scope:.*scoped/);
	screens[2].handleInput("\t");
	assert.match(screens[2].render(100).join("\n"), /Scope:.*all/);
	screens[2].handleInput("f");
	screens[2].handleInput("\r");
	await nextTurn();
	await nextTurn();
	screens[3].handleInput("\r");
	await nextTurn();
	await nextTurn();
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await result;
	assert.deepEqual(updates, [
		{ role: "conclave", setting: "model", value: "provider/fallback" },
		{ role: "conclave", setting: "thinking", value: "low" },
	]);
	assert.deepEqual(userSettings, { defaultModel: "provider/conclave" });
});

test("Backspace from Role settings returns to the Work picker", async () => {
	const screens = [];
	const controller = {
		get: () => ({
			conclave: { model: "provider/conclave", thinking: "medium" },
			executor: { model: "provider/executor", thinking: "high" },
			observer: { model: "provider/observer", thinking: "medium" },
			oracle: { model: "provider/oracle", thinking: "high" },
		}),
		set: () => {},
	};
	const service = { listWork: () => [] };
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
	const result = showKhala(service, context, "user", undefined, controller);
	await nextTurn();
	screens[0].handleInput("r");
	await nextTurn();
	screens[1].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 3);
	assert.match(screens[2].render(100).join("\n"), /No active Work/);
	screens[2].handleInput("\u001b");
	await result;
});

test("empty Work lists explain their state inside the TUI", async () => {
	const screens = [];
	const service = { listWork: () => [] };
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
	const result = showKhala(service, context);
	await nextTurn();
	assert.match(screens[0].render(100).join("\n"), /No active Work/);
	screens[0].handleInput("\u001b");
	await result;
});

test("TUI schedules runtime recovery effects and refreshes the view", async () => {
	const screens = [];
	const effects = [];
	let resolveRecovery;
	const work = {
		workId: "unreachable-work",
		state: "active",
		revision: 2,
		terms: { title: "Recoverable Executor" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		execution: { executionId: "execution-1", state: "running", runtimeState: "unreachable" },
		nextAction: "Executor runtime is unreachable. Recover it from Actions.",
		queuedSequence: 1,
	};
	const service = {
		listWork: () => [
			{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction },
		],
		inspectWork: () => work,
		availableActions: () => [
			{ id: "recover:unreachable-work:2", label: "Recover Work", enabled: true, kind: "recover" },
		],
		perform: async (command) =>
			new Promise((resolve) => {
				command.onRecoveryUpdate?.({ stage: "restoring", message: "Restoring the Executor" });
				resolveRecovery = () => {
					work.revision = 3;
					work.execution.runtimeState = "idle";
					work.nextAction = "Khala is continuing automatically.";
					resolve({ value: work });
				};
			}),
		processPendingEffects: async () => {
			effects.push("processed");
		},
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

	const result = showKhala(service, context);
	await nextTurn();
	screens[0].handleInput("\r");
	await nextTurn();
	screens[1].handleInput("\r");
	await nextTurn();
	screens[2].handleInput("\r");
	await nextTurn();
	assert.match(screens[3].render(100).join("\n"), /Status\s+in progress/);
	assert.match(screens[3].render(100).join("\n"), /Progress\s+restoring\s+Restoring the Executor/);
	assert.match(screens[3].render(100).join("\n"), /recovery is in progress/);
	screens[3].handleInput("\u001b");
	assert.equal(screens.length, 4);
	resolveRecovery();
	await nextTurn();
	assert.match(screens[3].render(100).join("\n"), /Status\s+in progress/);
	assert.doesNotMatch(screens[3].render(100).join("\n"), /Status\s+succeeded/);
	assert.deepEqual(effects, ["processed"]);
	await nextTurn();
	assert.match(screens[4].render(100).join("\n"), /Recoverable Executor[\s\S]*Work\s+active/);
	assert.match(screens[4].render(100).join("\n"), /Summary\s+Recoverable Executor/);
	assert.match(screens[4].render(100).join("\n"), /Next\s+Khala is continuing automatically\./);
	assert.doesNotMatch(screens[4].render(100).join("\n"), /^(?:Execution|Runtime)\s/m);
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await result;
});

test("TUI distinguishes a failed recovery from a completed recovery", async () => {
	const screens = [];
	const work = {
		workId: "unreachable-work",
		state: "active",
		revision: 4,
		terms: { title: "Unreachable Work" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		execution: { executionId: "execution-1", state: "running", runtimeState: "unreachable" },
		nextAction: "Recover the Work",
	};
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, nextAction: work.nextAction }],
		inspectWork: () => work,
		availableActions: () => [{ id: "recover:unreachable-work:4", label: "Recover Work", enabled: true, kind: "recover" }],
		perform: async () => ({
			value: {
				...work,
				state: "stopped",
				stopReason: "failed",
				revision: 5,
				execution: { ...work.execution, state: "running", runtimeState: "unreachable" },
				nextAction: "Execution could not be recovered",
			},
		}),
		processPendingEffects: async () => {},
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

	const result = showKhala(service, context);
	await nextTurn();
	screens[0].handleInput("\r");
	await nextTurn();
	screens[1].handleInput("\r");
	await nextTurn();
	screens[2].handleInput("\r");
	await nextTurn();
	const recovery = screens[3].render(100).join("\n");
	assert.match(recovery, /Status\s+failed/);
	assert.match(recovery, /Progress\s+stopped/);
	assert.match(recovery, /Next\s+Inspect Evidence and decide what to do next/);
	assert.doesNotMatch(recovery, /Status\s+succeeded/);
	screens[3].handleInput("\u001b");
	await nextTurn();
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await result;
});
