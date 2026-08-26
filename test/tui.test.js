import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
			runtimeState: "unreachable",
			usage: { inputTokens: 2, outputTokens: 3, cacheHitTokens: 5, cacheMissTokens: 7 },
		},
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		lastError: {
			summary: "Executor runtime failed.",
			remediation: "Inspect Evidence; do not restart the primary Pi session.",
			learning: { failure: "runtime disconnected", missionSpecificity: "Mission terms were explicit.", nextMissionGuidance: "Inspect the runtime before changing scope." },
		},
		nextAction: "Executor runtime is unreachable. Recover it from Actions.",
	};
	const service = {
		listWork: () => [
			{
				workId: work.workId,
				title: work.terms.title,
				state: work.state,
				executionState: "running",
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
	assert.match(initialView, /Work[^\n]*\n/);
	assert.doesNotMatch(initialView, /admission creates a Mission/);
	assert.match(initialView, /TITLE\s+ID\s+STATE\s+EXECUTION/);
	assert.match(initialView, /Work\s+work-1\s+active\s+running/);
	assert.doesNotMatch(initialView, /scope|Filter Work/);
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
	assert.match(overview, /Work active/);
	assert.match(overview, /Mission in progress/);
	assert.match(overview, /Execution running/);
	assert.match(overview, /Runtime unreachable/);
	assert.doesNotMatch(overview, /mission-1|execution-1/);
	assert.match(overview, /Next: Executor runtime is unreachable\. Recover it from Actions\./);
	assert.doesNotMatch(overview, /Work metadata/);
	assert.doesNotMatch(overview, /Budget/);
	assert.doesNotMatch(overview, /Cache hits/);
	assert.ok(screens[3].render(100).length <= 15);
	assert.match(overview, /Actions/);
	assert.match(overview, /Evidence/);
	assert.match(overview, /Archive/);
	assert.doesNotMatch(overview, /Overview/);

	screens[3].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 5);
	const actions = screens[4].render(100).join("\n");
	assert.match(actions, /Visible action/);
	assert.match(actions, /Work action/);
	assert.match(actions, /Recover/);
	assert.doesNotMatch(actions, /Recover Work/);
	assert.ok(actions.indexOf("Recover") < actions.indexOf("Visible action"));
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
	assert.match(evidence, /mission: in progress/);
	assert.match(evidence, /execution: running/);
	assert.match(evidence, /runtime: unreachable/);
	assert.match(evidence, /activity: execution recorded/);
	assert.match(evidence, /signal: none/);
	assert.match(evidence, /signal evidence: none/);
	assert.match(evidence, /provider observation: none/);
	assert.match(evidence, /review request: none/);
	assert.match(evidence, /review status: none/);
	assert.match(evidence, /Error\s+Executor runtime failed\./);
	assert.match(evidence, /Next step\s+Inspect Evidence\. Do not restart the primary Pi session\./);
	assert.match(evidence, /learning: Mission terms were explicit\./);
	assert.doesNotMatch(evidence, /;/);
	assert.ok(screens[6].render(100).length <= 24);
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
	assert.match(unadmittedOverview, /Work submitted/);
	assert.match(unadmittedOverview, /Mission not admitted/);
	assert.doesNotMatch(unadmittedOverview, /Conclave admission failed/);
	assert.doesNotMatch(unadmittedOverview, /remediation Open \/khala/);
	assert.match(unadmittedOverview, /Execution not started/);
	assert.match(unadmittedOverview, /Runtime unavailable/);
	screens[13].handleInput("\u007f");
	await nextTurn();
	screens[14].handleInput("\u001b");
	await result;
});

test("Provider observation archive entries show feedback and evidence", async () => {
	const screens = [];
	const work = {
		workId: "provider-work",
		state: "active",
		revision: 2,
		terms: { title: "Provider feedback" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: { executionId: "execution-1", state: "running", runtimeState: "idle" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Conclave is assessing provider feedback.",
	};
	const observation = {
		sequence: 1,
		id: "record-1",
		kind: "observation",
		actor: "monitor",
		workId: work.workId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: "Provider observation changed: review-comment.",
		evidenceRefs: ["https://github.com/example/project/pull/43", "review-comment:43:comment-1"],
		recordedAt: "2026-01-01T00:00:00.000Z",
		payload: {
			observationId: "review-comment:43:comment-1",
			kind: "review-comment",
			providerId: "43",
			status: "commented",
			feedback: ["Add the cleanup-waits sentence."],
			author: "reviewer",
			reviewState: "COMMENTED",
		},
	};
	const service = {
		listWork: () => [
			{
				workId: work.workId,
				title: work.terms.title,
				state: work.state,
				executionState: work.execution.state,
				nextAction: work.nextAction,
			},
		],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [observation], asOfSequence: 1 }),
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
	assert.doesNotMatch(screens[1].render(100).join("\n"), /Failure recorded/);
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	assert.match(screens[2].render(100).join("\n"), /#1 observation/);
	screens[2].handleInput("\r");
	await nextTurn();
	const details = screens[3].render(100).join("\n");
	assert.match(details, /Provider observation: review comment/);
	assert.match(details, /provider: 43/);
	assert.match(details, /status: commented/);
	assert.match(details, /feedback \(1\)/);
	assert.match(details, /Add the cleanup-waits sentence/);
	assert.match(details, /Evidence \(2\)/);
	assert.match(details, /review-comment:43:comment-1/);
	screens[3].handleInput("\u001b");
	await nextTurn();
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await nextTurn();
	screens[6].handleInput("\u001b");
	await result;
});

test("Evidence presents provider context and Conclave delivery without raw payloads", async () => {
	const screens = [];
	const work = {
		workId: "evidence-work",
		state: "active",
		revision: 4,
		terms: { title: "Lifecycle hardening demo" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: { executionId: "execution-new", state: "running", runtimeState: "unreachable" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		lastSignal: {
			signalId: "signal-1",
			executionId: "execution-new",
			kind: "ready",
			summary: "Ready after provider feedback.",
			evidence: ["diff", "validation", "head", "tests"],
			observedAt: "2026-08-25T22:40:00Z",
		},
		reviewRequest: {
			provider: "github",
			principalId: "pesap",
			providerId: "43",
			url: "https://github.com/pesap/khala/pull/43",
			repository: "pesap/khala",
			status: "draft",
			sourceBranch: "khala/demo",
			targetBranch: "main",
			headCommit: "head",
			diffSummary: "documentation-only change",
			validation: ["npm run check"],
		},
		lastObservation: {
			observationId: "review-comment:43:IC_kwDOTlm-4c8AAAABQt6GhQ",
			kind: "review-comment",
			providerId: "43",
			status: "commented",
			summary: "Follow-up review requests the cleanup sentence.",
			changed: true,
			observedAt: "2026-08-25T22:35:00Z",
			feedback: ["Add the cleanup-waits sentence now."],
			details: {
				pullRequest: {
					url: "https://github.com/pesap/khala/pull/43",
					status: "draft",
					state: "open",
					reviewDecision: "",
					mergedAt: null,
				},
				comments: [
					{
						id: "IC_kwDOTlm-4c8AAAABQt6GhQ",
						author: "pesap",
						authorAssociation: "OWNER",
						body: "Changes requested: add one sentence to docs/demo-work.md stating that cleanup waits for an active Executor turn before stopping its runtime. Keep the change documentation-only and resend the ready evidence after validation.",
						createdAt: "2026-08-25T21:11:06Z",
						url: "https://github.com/pesap/khala/pull/43#issuecomment-5416846981",
					},
					{
						id: "IC_kwDOTlm-4c8AAAABQuBR7A",
						author: "pesap",
						authorAssociation: "OWNER",
						body: "Follow-up review: please add the cleanup-waits-for-the-active-Executor-turn sentence now, then validate the documentation-only diff and send a fresh ready Signal.",
						createdAt: "2026-08-25T21:21:03Z",
						url: "https://github.com/pesap/khala/pull/43#issuecomment-5416964588",
					},
				],
				checks: [
					{ kind: "check-run", name: "validate", status: "COMPLETED", conclusion: "FAILURE", workflowName: "CI" },
					{ kind: "check-run", name: "validate", status: "COMPLETED", conclusion: "FAILURE", workflowName: "CI" },
				],
			},
		},
		nextAction: "Executor runtime is unreachable. Recover it from Actions.",
	};
	const observation = {
		sequence: 1,
		id: "record-observation",
		kind: "observation",
		actor: "monitor",
		workId: work.workId,
		executionId: "execution-old",
		payloadVersion: 1,
		summary: "Provider observation changed: review-comment.",
		evidenceRefs: [work.reviewRequest.url, work.lastObservation.observationId],
		recordedAt: "2026-08-25T22:35:00Z",
		payload: work.lastObservation,
	};
	const delivery = {
		sequence: 2,
		id: "record-delivery",
		kind: "delivery",
		actor: "conclave",
		workId: work.workId,
		executionId: "execution-new",
		payloadVersion: 1,
		summary: "Authorized provider review feedback was delivered to the Executor.",
		evidenceRefs: work.lastObservation.feedback,
		recordedAt: "2026-08-25T22:36:00Z",
		payload: { observationId: work.lastObservation.observationId, feedback: work.lastObservation.feedback, delivered: true },
	};
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction }],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [observation, delivery], asOfSequence: 2 }),
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
	const overview = screens[1].render(120).join("\n");
	assert.match(overview, /Execution running \(no active runtime\)/);
	assert.match(overview, /Runtime unreachable/);
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	const evidence = screens[2].render(120).join("\n");
	assert.match(evidence, /state: active/);
	assert.match(evidence, /mission: in progress/);
	assert.match(evidence, /execution: running \(no active runtime\)/);
	assert.match(evidence, /runtime: unreachable/);
	assert.match(evidence, /activity: execution recorded \(runtime unreachable, no active turn\)/);
	assert.match(evidence, /signal: signal/);
	assert.match(evidence, /signal evidence: 4 evidence items\. Open Archive for details/);
	assert.match(evidence, /archive access: Open Archive for details/);
	assert.match(evidence, /PR status: open/);
	assert.match(evidence, /CI checks \(2\)/);
	assert.match(evidence, /review comments: 2 available — select Review comments to explore/);
	assert.doesNotMatch(evidence, /Add one sentence to docs\/demo-work\.md/);
	assert.match(evidence, /review request: https:\/\/github\.com\/pesap\/khala\/pull\/43/);
	assert.match(evidence, /review status: draft/);
	assert.match(evidence, /conclave handoff: delivered Execution execution-new/);
	assert.match(evidence, /handoff observation: review-comment:43/);
	assert.doesNotMatch(evidence, /"comments"|"statusCheckRollup"/);
	screens[2].handleInput("\u001b");
	await nextTurn();
	assert.match(screens[3].render(120).join("\n"), /Review comments \(2\)/);
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\r");
	await nextTurn();
	assert.match(screens[4].render(120).join("\n"), /Review comments/);
	assert.match(screens[4].render(120).join("\n"), /pesap/);
	screens[4].handleInput("\r");
	await nextTurn();
	const comment = screens[5].render(120).join("\n");
	assert.match(comment, /author: pesap \(OWNER\)/);
	assert.match(comment, /Changes requested: add one sentence to docs\/demo-work\.md/);
	assert.match(comment, /https:\/\/github\.com\/pesap\/khala\/pull\/43#issuecomment-5416846981/);
	screens[5].handleInput("\u001b");
	await nextTurn();
	screens[6].handleInput("\u001b");
	await nextTurn();
	screens[7].handleInput("\u001b");
	await nextTurn();
	screens[8].handleInput("\u001b");
	await result;
});

test("Work picker stays minimal, filters active Work, and marks failures", async () => {
	const screens = [];
	const works = [
		{
			workId: "active-work",
			title: "Add a compact Khala lifecycle walkthrough with a deliberately long name",
			state: "active",
			missionState: "active",
			executionState: "running",
			hasFailure: false,
			revision: 1,
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "Continue the Work",
		},
		{
			workId: "execution-failed-work",
			title: "Active Work with failed Execution",
			state: "active",
			missionState: "active",
			executionState: "failed",
			hasFailure: true,
			revision: 2,
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "Replace the failed Execution.",
		},
		{
			workId: "completed-work",
			title: "Completed mission to hide by default",
			state: "succeeded",
			missionState: "succeeded",
			executionState: "completed",
			hasFailure: false,
			revision: 2,
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "No action is needed.",
		},
		{
			workId: "cancelled-work",
			title: "Cancelled Work to hide by default",
			state: "stopped",
			stopReason: "cancelled",
			missionState: "active",
			executionState: "stopped",
			hasFailure: true,
			revision: 3,
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "Work was stopped by cancellation.",
		},
		{
			workId: "failed-work",
			title: "失敗した実行 remains visible",
			state: "stopped",
			stopReason: "failed",
			missionState: "active",
			executionState: "failed",
			hasFailure: true,
			revision: 4,
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "Inspect the failure evidence.",
		},
	];
	const service = {
		listWork: () => works,
		inspectRuntime: async (workId) => ({
			workId,
			revision: 1,
			state: "active",
			terms: {
				title: "Add a compact Khala lifecycle walkthrough with a deliberately long name",
				objective: "Test picker state",
				context: "",
				scope: "",
				acceptanceCriteria: ["The picker preserves its state"],
				constraints: [],
				validation: [],
				maxTokens: 100,
			},
			budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
			nextAction: "Continue the Work",
			queuedSequence: 1,
		}),
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
	const current = screens[0].render(100).join("\n");
	assert.match(current, /Work/);
	assert.match(current, /Add a compact Khala lifecycle/);
	assert.match(current, /stopped\s+failed/);
	assert.match(current, /active\s+failed/);
	assert.match(current, /failed-work/);
	assert.match(current, /…/);
	assert.doesNotMatch(current, /completed-work|cancelled-work|scope|Filter Work/);
	const rows = current.split("\n");
	const activeRow = rows.find((line) => line.includes("active-work"));
	const failedRow = rows.find((line) => line.includes("失敗した実行"));
	assert.equal(
		visibleWidth(activeRow?.slice(0, activeRow.indexOf("active-work")) ?? ""),
		visibleWidth(failedRow?.slice(0, failedRow.indexOf("failed-work")) ?? ""),
	);
	const narrow = screens[0].render(80).join("\n");
	assert.match(narrow, /EXECUTION/);
	assert.match(narrow, /running/);

	for (const character of "walkthrough") screens[0].handleInput(character);
	const filtered = screens[0].render(100).join("\n");
	assert.match(filtered, /active-work/);
	assert.doesNotMatch(filtered, /Completed mission to hide|失敗した実行 remains visible|Active Work with failed Execution/);
	screens[0].handleInput("\r");
	await nextTurn();
	screens[1].handleInput("\u001b");
	await nextTurn();
	assert.match(screens[2].render(100).join("\n"), /alkthrough/);
	assert.doesNotMatch(screens[2].render(100).join("\n"), /Completed mission to hide|失敗した実行 remains visible|Active Work with failed Execution/);
	screens[2].handleInput("\u001b");
	await result;
});

test("Blocked Executions are prominent while Signal details stay available in Archive", async () => {
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
	assert.match(initial, /active\s+blocked/);
	assert.doesNotMatch(initial, /Inspect blocking signal/);
	screens[0].handleInput("\r");
	await nextTurn();
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /Execution blocked/);
	assert.match(overview, /Runtime finishing current turn/);
	assert.equal((overview.match(/BLOCKED/g) ?? []).length, 0);
	assert.ok(overview.indexOf("Archive") < overview.indexOf("Inspect blocking signal"));
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
	assert.doesNotMatch(conciseEvidence, /The Executor cannot publish under the Mission constraints/);
	assert.match(conciseEvidence, /signal evidence: 3 evidence items\. Open Archive for details/);
	assert.doesNotMatch(conciseEvidence, /bounded wait completed/);
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\r");
	await nextTurn();
	assert.match(screens[6].render(100).join("\n"), /#8 Signal: Blocked/);
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
	assert.match(screens[1].render(100).join("\n"), /No active Work/);
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
		inspectRuntime: async () => work,
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
	assert.match(screens[3].render(100).join("\n"), /status    in progress/);
	assert.match(screens[3].render(100).join("\n"), /progress  restoring  Restoring the Executor/);
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
	assert.match(screens[4].render(100).join("\n"), /Work active/);
	assert.match(screens[4].render(100).join("\n"), /Execution running/);
	assert.match(screens[4].render(100).join("\n"), /Khala is continuing automatically/);
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
