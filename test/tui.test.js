import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { showKhala } from "../dist/src/tui.js";

const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function nextTurn() {
	return new Promise((resolve) => setImmediate(resolve));
}

test("Khala keeps mission information and navigation inside the small TUI", async () => {
	const screens = [];
	const notices = [];
	const work = {
		workId: "work-1",
		state: "active",
		revision: 0,
		terms: { title: "Work" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: {
			executionId: "execution-1",
			state: "running",
			runtimeState: "idle",
			usage: { inputTokens: 2, outputTokens: 3, cacheHitTokens: 5, cacheMissTokens: 7 },
		},
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Admit the Work",
	};
	const service = {
		listWork: () => [
			{
				workId: work.workId,
				title: work.terms.title,
				state: work.state,
				nextAction: work.nextAction,
			},
		],
		inspectWork: () => work,
		inspectRuntime: async () => work,
		availableActions: (_workId, _actor, _revision, runtimeState) => [
			{ id: "hidden", label: "Hidden action", enabled: false, kind: "cancel" },
			...(runtimeState === "unreachable"
				? [{ id: "recover", label: "Recover Work", enabled: true, kind: "recover" }]
				: []),
			{ id: "visible", label: "Visible action", enabled: true, kind: "cancel" },
		],
		readRecords: () => ({
			items: [
				{
					sequence: 1,
					id: "record-1",
					kind: "submission",
					actor: "user",
					workId: work.workId,
					payloadVersion: 1,
					summary: "Work submitted",
					evidenceRefs: [],
					recordedAt: "2026-01-01T00:00:00.000Z",
					payload: { title: work.terms.title },
				},
			],
			asOfSequence: 1,
		}),
	};
	const context = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message) => notices.push(message),
			custom: (factory) =>
				new Promise((resolve) => {
					const done = (value) => resolve(value);
					const screen = factory({ requestRender() {} }, theme, {}, done);
					screens.push(screen);
				}),
		},
	};

	const result = showKhala(service, context);
	await nextTurn();
	assert.equal(screens.length, 1);
	const initialView = screens[0].render(100).join("\n");
	assert.match(initialView, /Khala[^\n]*\n/);
	assert.doesNotMatch(initialView, /admission creates a Mission/);
	assert.match(initialView, /Work  active  work-1/);
	assert.match(initialView, /\n\n +↑↓ navigate  \/ filter  r role settings  enter select  escape\/ctrl\+c cancel/);
	assert.ok(screens[0].render(100).length <= 12);

	screens[0].handleInput("?");
	await nextTurn();
	assert.equal(screens.length, 2);
	assert.match(screens[1].render(100).join("\n"), /active means the lifecycle is open/);
	assert.match(screens[1].render(100).join("\n"), /idle means waiting for the next Signal/);
	assert.match(screens[1].render(100).join("\n"), /\? help/);
	assert.equal(notices.length, 0);
	screens[1].handleInput("\u001b");
	await nextTurn();
	assert.equal(screens.length, 3);

	screens[2].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 4);
	const overview = screens[3].render(100).join("\n");
	assert.match(overview, /work       active/);
	assert.match(overview, /mission    active/);
	assert.match(overview, /execution  active/);
	assert.match(overview, /runtime    idle/);
	assert.doesNotMatch(overview, /mission-1|execution-1/);
	assert.match(overview, /next       Admit the Work/);
	assert.doesNotMatch(overview, /Work metadata/);
	assert.doesNotMatch(overview, /Budget/);
	assert.doesNotMatch(overview, /Cache hits/);
	assert.ok(screens[3].render(100).length <= 15);
	assert.match(overview, /Actions/);
	assert.doesNotMatch(overview, /Overview/);

	work.execution.runtimeState = "unreachable";
	work.nextAction = "Executor runtime is unreachable; recover it from Actions.";
	screens[3].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 5);
	const actions = screens[4].render(100).join("\n");
	assert.match(actions, /Visible action/);
	assert.match(actions, /Recover Work/);
	assert.ok(actions.indexOf("Recover Work") < actions.indexOf("Visible action"));
	assert.doesNotMatch(actions, /Hidden action/);
	assert.doesNotMatch(actions, /khala-recover/);
	screens[4].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 6);

	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 7);
	const evidence = screens[6].render(100).join("\n");
	assert.match(evidence, /state: active/);
	assert.match(evidence, /mission: active/);
	assert.match(evidence, /execution: active/);
	assert.match(evidence, /runtime: unreachable/);
	assert.match(evidence, /activity: execution recorded/);
	assert.match(evidence, /signal: none/);
	assert.match(evidence, /signal evidence: none/);
	assert.match(evidence, /provider observation: none/);
	assert.match(evidence, /review request: none/);
	assert.match(evidence, /review status: none/);
	assert.ok(screens[6].render(100).length <= 20);
	screens[6].handleInput("\u001b");
	await nextTurn();
	assert.equal(screens.length, 8);

	screens[7].handleInput("\u001b[B");
	screens[7].handleInput("\u001b[B");
	screens[7].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 9);
	assert.match(screens[8].render(100).join("\n"), /#1 submission/);
	screens[8].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 10);
	assert.match(screens[9].render(100).join("\n"), /summary: Work submitted/);
	screens[9].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 11);
	screens[10].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 12);
	screens[11].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 13);
	work.state = "submitted";
	delete work.mission;
	delete work.missionState;
	delete work.execution;
	work.lastError = {
		code: "external-failure",
		summary: "Conclave admission failed: quota exceeded",
		retryable: true,
		remediation: "Open /khala, press r, choose a working Conclave model, then retry admission.",
		evidenceRefs: [],
	};
	screens[12].handleInput("\r");
	await nextTurn();
	const unadmittedOverview = screens[13].render(100).join("\n");
	assert.match(unadmittedOverview, /work       submitted/);
	assert.match(unadmittedOverview, /mission    not admitted/);
	assert.doesNotMatch(unadmittedOverview, /Conclave admission failed/);
	assert.doesNotMatch(unadmittedOverview, /remediation Open \/khala/);
	assert.match(unadmittedOverview, /execution  not started/);
	assert.match(unadmittedOverview, /runtime    unavailable/);
	screens[13].handleInput("\u007f");
	await nextTurn();
	screens[14].handleInput("\u001b");
	await result;
});

test("Blocked Executions are prominent while Signal details stay available in History", async () => {
	const screens = [];
	const evidence = [
		"The bounded wait completed successfully.",
		"Validation passed with a clean tracked diff.",
		"Publishing would violate the immutable Mission constraints.",
	];
	const work = {
		workId: "blocked-work",
		state: "active",
		revision: 3,
		terms: { title: "Two-minute execution job" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: { executionId: "execution-1", state: "blocked", runtimeState: "working" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Conclave assessment is pending.",
		lastSignal: { signalId: "signal-1", executionId: "execution-1", kind: "blocked", summary: "The Executor cannot publish under the Mission constraints.", evidence },
	};
	const service = {
		listWork: () => [
			{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction },
		],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({
			items: [
				{
					sequence: 8,
					id: "record-8",
					kind: "signal",
					actor: "executor",
					workId: work.workId,
					payloadVersion: 1,
					summary: "blocked Signal from Executor.",
					evidenceRefs: evidence,
					recordedAt: "2026-08-24T17:48:39.214Z",
					payload: { kind: "blocked", summary: work.lastSignal.summary, evidence },
				},
			],
			asOfSequence: 8,
		}),
	};
	const context = {
		hasUI: true,
		mode: "tui",
		ui: {
			notify: () => {},
			custom: (factory) =>
				new Promise((resolve) => {
					const done = (value) => resolve(value);
					screens.push(factory({ requestRender() {} }, theme, {}, done));
				}),
		},
	};
	const result = showKhala(service, context);
	await nextTurn();
	const initial = screens[0].render(100).join("\n");
	assert.match(initial, /Two-minute execution/);
	assert.match(initial, /Work  active  blocked-work.*blocked/);
	assert.doesNotMatch(initial, /Inspect blocking signal/);
	screens[0].handleInput("\r");
	await nextTurn();
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /execution  blocked/);
	assert.match(overview, /runtime    finishing current turn/);
	assert.equal((overview.match(/BLOCKED/g) ?? []).length, 0);
	assert.ok(overview.indexOf("History") < overview.indexOf("Inspect blocking signal"));
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	const blockingDetail = screens[2].render(100).join("\n");
	assert.match(blockingDetail, /Blocking signal/);
	assert.match(blockingDetail, /Executor response/);
	assert.match(blockingDetail, /The Executor cannot publish under the Mission constraints/);
	assert.match(blockingDetail, /The bounded wait completed successfully/);
	screens[2].handleInput("\u001b");
	await nextTurn();
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\r");
	await nextTurn();
	const conciseEvidence = screens[4].render(100).join("\n");
	assert.doesNotMatch(conciseEvidence, /attention: BLOCKED/);
	assert.match(conciseEvidence, /signal: blocking signal/);
	assert.match(conciseEvidence, /signal evidence: 3 evidence items; open History for details/);
	assert.doesNotMatch(conciseEvidence, /bounded wait completed/);
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\r");
	await nextTurn();
	assert.match(screens[6].render(100).join("\n"), /#8 Signal · Blocked/);
	screens[6].handleInput("\r");
	await nextTurn();
	const signalDetail = screens[7].render(100).join("\n");
	assert.match(signalDetail, /Executor response/);
	assert.match(signalDetail, /The Executor cannot publish under the Mission constraints/);
	assert.match(signalDetail, /The bounded wait completed successfully/);
	screens[7].handleInput("\u001b");
	await nextTurn();
	screens[8].handleInput("\u007f");
	await nextTurn();
	screens[9].handleInput("\u001b");
	await nextTurn();
	screens[10].handleInput("\u001b");
	await result;
});

test("Role settings open with r and use the native model selector", async () => {
	initTheme();
	const screens = [];
	const selections = [
		"Conclave — provider/conclave (medium)",
		"Model — provider/conclave",
		"Conclave — provider/fallback (medium)",
		"Thinking — medium",
		"low",
		undefined,
	];
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
	const context = {
		hasUI: true,
		mode: "tui",
		scopedModels: [],
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
					screens.push(factory({ requestRender() {} }, theme, {}, done));
				}),
		},
	};
	const result = showKhala(service, context, "user", undefined, controller);
	await nextTurn();
	assert.doesNotMatch(screens[0].render(100).join("\n"), /→ Role settings/);
	screens[0].handleInput("r");
	await nextTurn();
	await nextTurn();
	assert.match(screens[1].render(100).join("\n"), /Model Name: Conclave model/);
	screens[1].handleInput("f");
	assert.match(screens[1].render(100).join("\n"), /Model Name: Fallback model/);
	screens[1].handleInput("\r");
	await nextTurn();
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
	assert.deepEqual(updates, [
		{ role: "conclave", setting: "model", value: "provider/fallback" },
		{ role: "conclave", setting: "thinking", value: "low" },
	]);
});

test("Backspace from Role settings returns to the Work picker", async () => {
	const screens = [];
	let terminalInput;
	let resolveRoleSelection;
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
			onTerminalInput: (handler) => {
				terminalInput = handler;
				return () => {};
			},
			select: async (_title, _options, options) =>
				new Promise((resolve) => {
					resolveRoleSelection = resolve;
					options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
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
	assert.ok(terminalInput);
	terminalInput("\u007f");
	resolveRoleSelection?.(undefined);
	await nextTurn();
	assert.equal(screens.length, 2);
	assert.match(screens[1].render(100).join("\n"), /No Work has been submitted\./);
	screens[1].handleInput("\u001b");
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
	assert.match(screens[0].render(100).join("\n"), /No Work has been submitted\./);
	screens[0].handleInput("\u001b");
	await result;
});

test("TUI schedules recovery effects and refreshes recovered Work", async () => {
	const screens = [];
	const effects = [];
	let resolveRecovery;
	const work = {
		workId: "cancelled-work",
		state: "cancelled",
		revision: 2,
		terms: { title: "Recoverable Work" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Work cancelled by the User.",
		queuedSequence: 1,
	};
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, nextAction: work.nextAction }],
		inspectRuntime: async () => work,
		availableActions: () => [
			{ id: "recover:cancelled-work:2", label: "Recover Work", enabled: true, kind: "recover" },
		],
		perform: async (command) =>
			new Promise((resolve) => {
				command.onRecoveryUpdate?.({ stage: "restoring", message: "Restoring the Work" });
				resolveRecovery = () => {
					work.state = "submitted";
					work.revision = 3;
					work.nextAction = "Recovered Work is pending Conclave admission.";
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
	assert.match(screens[3].render(100).join("\n"), /status    in progress/);
	assert.match(screens[3].render(100).join("\n"), /progress  restoring  Restoring the Work/);
	assert.match(screens[3].render(100).join("\n"), /recovery is in progress/);
	screens[3].handleInput("\u001b");
	assert.equal(screens.length, 4);
	resolveRecovery();
	await nextTurn();
	assert.match(screens[3].render(100).join("\n"), /status    succeeded/);
	assert.match(screens[3].render(100).join("\n"), /progress  complete/);
	assert.match(screens[3].render(100).join("\n"), /No action needed/);
	assert.deepEqual(effects, ["processed"]);
	screens[3].handleInput("\u001b");
	await nextTurn();
	assert.match(screens[4].render(100).join("\n"), /work       submitted/);
	assert.match(screens[4].render(100).join("\n"), /mission    not admitted/);
	assert.match(screens[4].render(100).join("\n"), /Recovered Work is pending Conclave admission/);
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
		inspectRuntime: async () => work,
		availableActions: () => [{ id: "recover:unreachable-work:4", label: "Recover Work", enabled: true, kind: "recover" }],
		perform: async () => ({
			value: {
				...work,
				state: "failed",
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
	assert.match(recovery, /status    failed/);
	assert.match(recovery, /progress  stopped/);
	assert.match(recovery, /Action needed/);
	assert.doesNotMatch(recovery, /status    succeeded/);
	screens[3].handleInput("\u001b");
	await nextTurn();
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await result;
});
