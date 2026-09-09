import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showKhala } from "../dist/src/tui.js";
import { theme, nextTurn } from "./helpers/tui-fixtures.mjs";

test("Khala keeps mission information and navigation inside the small TUI", async () => {
	const screens = [];
	const notices = [];
	const work = {
		workId: "work-1",
		state: "active",
		revision: 0,
		terms: { title: "Work", objective: "Deliver the complete documented behavior with all details." },
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
					recordNumber: 1,
					id: "record-1",
					kind: "submission",
					actor: "user",
					workId: work.workId,
					payloadVersion: 1,
					summary: "Work submitted",
					evidenceRefs: [],
					recordedAt: "2026-01-01T00:00:00.000Z",
					payload: { title: work.terms.title, objective: work.terms.objective },
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
	assert.match(initialView, /→\s+Work\s+work-1\s+active\s+running/);
	assert.match(initialView, /type to filter/);
	assert.match(initialView, /\?\s+help/);
	assert.match(initialView, /r\s+settings/);
	assert.doesNotMatch(initialView, /Help|—|…/);
	assert.match(initialView, /home\s+first/);
	assert.match(initialView, /up\/down\s+move/);
	assert.match(initialView, /enter\s+open/);
	assert.match(initialView, /escape\/ctrl\+c\/backspace\s+back/);
	assert.ok(screens[0].render(100).length <= 18);

	screens[0].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 2);
	assert.equal(notices.length, 0);
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /Work\s+active/);
	assert.match(overview, /Summary\s+Deliver the complete documented behavior with all details\./);
	assert.match(overview, /Attention\s+Executor runtime failed\./);
	assert.match(overview, /Next\s+Executor runtime is unreachable\./);
	assert.match(overview, /Freshness\s+Saved revision 0/);
	assert.doesNotMatch(overview, /^(?:Mission|Execution|Runtime)\s/m);
	assert.doesNotMatch(overview, /Work metadata/);
	assert.doesNotMatch(overview, /Budget/);
	assert.doesNotMatch(overview, /Cache hits/);
	assert.ok(screens[1].render(100).length <= 18);
	assert.match(overview, /Actions/);
	assert.match(overview, /Evidence/);
	assert.match(overview, /Archive/);
	assert.doesNotMatch(overview, /Overview/);

	screens[1].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 3);
	const actions = screens[2].render(100).join("\n");
	assert.match(actions, /Cancel/);
	assert.match(actions, /Actions/);
	assert.match(actions, /Recover/);
	assert.doesNotMatch(actions, /Recover Work|Visible action/);
	assert.ok(actions.indexOf("Recover") < actions.indexOf("Refresh runtime"));
	assert.ok(actions.indexOf("Refresh runtime") < actions.indexOf("Cancel"));
	assert.doesNotMatch(actions, /Hidden action/);
	assert.doesNotMatch(actions, /khala-recover/);
	screens[2].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 4);

	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 5);
	const evidence = screens[4].render(100).join("\n");
	assert.match(evidence, /SEQ\s+KIND\s+ACTOR\s+TIME\s+SUMMARY/);
	assert.match(evidence, /→\s+1\s+submission\s+user/);
	assert.match(evidence, /Work submitted/);
	assert.doesNotMatch(evidence, /Provider summary|Review request|Conclave handoff|Error/);
	assert.doesNotMatch(evidence, /Mission terms were explicit/);
	assert.match(evidence, /escape\/ctrl\+c\/backspace back/);
	assert.doesNotMatch(evidence, /Keybindings|—|…/);
	assert.match(evidence, /enter\s+inspect/);
	assert.ok(screens[4].render(100).length <= 30);
	screens[4].handleInput("\u001b");
	await nextTurn();
	assert.equal(screens.length, 6);

	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 7);
	assert.match(screens[6].render(100).join("\n"), /1\s+submission/);
	screens[6].handleInput("\r");
	await nextTurn();
	assert.equal(screens.length, 8);
	const archiveList = screens[6].render(100).join("\n");
	assert.match(archiveList, /Archive 1 record[^\n]*\n\n/);
	assert.match(archiveList, /→\s+1\s+submission/);
	const recordDetail = screens[7].render(100).join("\n");
	assert.match(recordDetail, /Submission 1/);
	assert.match(recordDetail, /Record ID\s+record-1/);
	assert.match(recordDetail, /Work ID\s+work-1/);
	assert.match(recordDetail, /Summary\s+Work submitted/);
	assert.match(recordDetail, /objective.*Deliver the complete documented behavior with all details/);
	screens[7].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 9);
	screens[8].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 10);
	screens[9].handleInput("\u007f");
	await nextTurn();
	assert.equal(screens.length, 11);
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
	screens[10].handleInput("\r");
	await nextTurn();
	const unadmittedOverview = screens[11].render(100).join("\n");
	assert.match(unadmittedOverview, /Work\s+Work\s+submitted/);
	assert.doesNotMatch(unadmittedOverview, /^(?:Mission|Execution|Runtime)\s/m);
	assert.match(unadmittedOverview, /Work\s+submitted \(attention\)/);
	assert.match(unadmittedOverview, /Summary\s+Deliver the complete documented behavior with all details\./);
	assert.match(unadmittedOverview, /Attention\s+Conclave admission failed/);
	assert.match(unadmittedOverview, /Next\s+Executor runtime is unreachable\./);
	assert.match(unadmittedOverview, /Freshness\s+Saved revision 0/);
	assert.doesNotMatch(unadmittedOverview, /[;:]/);
	screens[11].handleInput("\u007f");
	await nextTurn();
	screens[12].handleInput("\u001b");
	await result;
});

test("Work picker refreshes, exposes history, and opens complete help", async () => {
	const screens = [];
	let work = {
		workId: "active-work",
		title: "Active Work",
		state: "active",
		executionState: "running",
		nextAction: "Executor is working.",
	};
	const service = { listWork: () => [work] };
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
	const result = showKhala(service, context, "user", { roleSettings: "r", comments: "c" });
	await nextTurn();
	assert.match(screens[0].render(100).join("\n"), /Active Work/);
	work = { ...work, title: "Refreshed Work" };
	screens[0].handleInput("\u0012");
	assert.match(screens[0].render(100).join("\n"), /Refreshed Work/);
	work = { ...work, state: "succeeded", executionState: "completed" };
	screens[0].handleInput("h");
	assert.match(screens[0].render(100).join("\n"), /Refreshed Work/);
	screens[0].handleInput("?");
	await nextTurn();
	assert.match(screens[1].render(100).join("\n"), /Work picker help/);
	assert.match(screens[1].render(100).join("\n"), /Refresh Work/);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
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
	const observationSummary =
		"Provider monitor failed: gh failed: Command failed: gh pr view 43\n--json state,merged,reviewDecision,statusCheckRollup,comments,reviews\nUnknown JSON field: merged\nAvailable fields:\nadditions";
	const observation = {
		sequence: 1,
		recordNumber: 1,
		id: "record-1",
		kind: "observation",
		actor: "monitor",
		workId: work.workId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: observationSummary,
		evidenceRefs: ["https://github.com/example/project/pull/43", "review-comment:43:comment-1"],
		recordedAt: "2026-01-01T00:00:00.000Z",
		payload: {
			summary: observationSummary,
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
		inspectWork: () => work,
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
	const archiveList = screens[2].render(100).join("\n");
	assert.match(archiveList, /1\s+observation\s+Provider monitor failed: gh failed: Command failed: gh pr view 43/);
	assert.doesNotMatch(archiveList, /Available fields/);
	screens[2].handleInput("\r");
	await nextTurn();
	const details = screens[3].render(100).join("\n");
	assert.match(details, /Observation 1/);
	assert.match(details, /Record ID\s+record-1/);
	assert.match(details, /providerId/);
	assert.match(details, /status/);
	assert.match(details, /Add the cleanup-waits sentence/);
	assert.match(details, /Available fields:/);
	assert.equal((details.match(/Provider monitor failed/g) ?? []).length, 1);
	assert.match(details, /Evidence references/);
	assert.match(details, /Execution ID\s+execution-1/);
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

test("Peer-Review lists provider comments separately from Evidence", async () => {
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
						id: "review-empty",
						author: "pesap",
						authorAssociation: "OWNER",
						source: "review",
						body: "",
					},
					{
						id: "IC_kwDOTlm-4c8AAAABQt6GhQ",
						author: "pesap",
						authorAssociation: "OWNER",
						source: "issue-comment",
						location: "docs/demo-work.md:12",
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
		recordNumber: 1,
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
		recordNumber: 2,
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
	const signal = {
		sequence: 3,
		recordNumber: 3,
		id: "record-signal",
		kind: "signal",
		actor: "executor",
		workId: work.workId,
		missionId: work.mission.missionId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: "ready Signal from Executor; preserve punctuation.",
		evidenceRefs: [work.reviewRequest.url, "head"],
		recordedAt: "2026-08-25T22:37:00Z",
		payload: {
			signalId: work.lastSignal.signalId,
			executionId: work.execution.executionId,
			kind: "ready",
			summary: work.lastSignal.summary,
			evidence: work.lastSignal.evidence,
			observedAt: work.lastSignal.observedAt,
		},
	};
	const reviewRequest = {
		sequence: 4,
		recordNumber: 4,
		id: "record-review-request",
		kind: "review-request",
		actor: "executor",
		workId: work.workId,
		missionId: work.mission.missionId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: "Draft review request 43 is ready.",
		evidenceRefs: [work.reviewRequest.url],
		recordedAt: "2026-08-25T22:34:00Z",
		payload: work.reviewRequest,
	};
	const learning = {
		sequence: 5,
		recordNumber: 5,
		id: "record-learning",
		kind: "error",
		actor: "monitor",
		workId: work.workId,
		missionId: work.mission.missionId,
		executionId: work.execution.executionId,
		payloadVersion: 1,
		summary: "Execution runtime failed.",
		evidenceRefs: [],
		recordedAt: "2026-08-25T22:38:00Z",
		payload: {
			summary: "Execution runtime failed.",
			learning: {
				failure: "The runtime closed.",
				missionSpecificity: "Archive learning is authoritative.",
				nextMissionGuidance: "Make the runtime constraint explicit.",
			},
		},
	};
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction }],
		inspectWork: () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [observation, delivery, signal, reviewRequest, learning], asOfSequence: 5 }),
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
	const result = showKhala(service, context, "user", { roleSettings: "r", comments: "v" });
	await nextTurn();
	screens[0].handleInput("\r");
	await nextTurn();
	const overview = screens[1].render(120).join("\n");
	assert.match(overview, /Summary\s+Lifecycle hardening demo/);
	assert.match(overview, /Next\s+Executor runtime is unreachable\./);
	assert.match(overview, /Freshness\s+Saved revision 4/);
	assert.doesNotMatch(overview, /Execution\s|Runtime\s|PR\s+#43/);
	assert.match(overview, /Peer-Review/);
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	const evidence = screens[2].render(120).join("\n");
	assert.match(evidence, /SEQ\s+KIND\s+ACTOR\s+TIME\s+SUMMARY/);
	assert.match(evidence, /2026-08-25 22:35:00\.000Z/);
	assert.doesNotMatch(evidence, /2026-08-25 22:35:00 UTC/);
	const evidenceLines = evidence.split("\n");
	const evidenceHeader = evidenceLines.find((line) => line.includes("SUMMARY"));
	const observationRow = evidenceLines.find((line) => line.includes("Provider observation changed"));
	assert.ok(evidenceHeader);
	assert.ok(observationRow);
	assert.equal(
		visibleWidth(evidenceHeader.slice(0, evidenceHeader.indexOf("SUMMARY"))),
		visibleWidth(observationRow.slice(0, observationRow.indexOf("Provider observation changed"))),
	);
	assert.match(evidence, /1\s+observation\s+monitor/);
	assert.match(evidence, /2\s+delivery\s+conclave/);
	assert.match(evidence, /3\s+ready\s+executor/);
	assert.match(evidence, /4\s+review request\s+executor/);
	assert.match(evidence, /ready Signal from Executor; preserve punctuation/);
	assert.ok(evidence.indexOf("4    review request") < evidence.indexOf("3    ready"));
	assert.ok(evidence.indexOf("3    ready") < evidence.indexOf("2    delivery"));
	assert.ok(evidence.indexOf("2    delivery") < evidence.indexOf("1    observation"));
	assert.match(evidence, /Next\s+Executor runtime is unreachable\. Recover it from Actions\./);
	assert.doesNotMatch(evidence, /Learning/);
	assert.match(evidence, /Provider observation changed: review-comment/);
	assert.match(evidence, /Authorized provider review feedback was delivered/);
	assert.doesNotMatch(evidence, /Review comments\s+2 available/);
	assert.doesNotMatch(evidence, /v comments/);
	assert.doesNotMatch(evidence, /select Review comments to explore/);
	const narrowEvidence = screens[2].render(70).join("\n");
	assert.match(narrowEvidence, /SEQ\s+KIND\s+SUMMARY/);
	assert.doesNotMatch(narrowEvidence, /2026-08-25 22:35:00\.000Z/);
	screens[2].handleInput("\u001b");
	await nextTurn();
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\r");
	await nextTurn();
	assert.match(screens[4].render(120).join("\n"), /Peer-Review/);
	assert.match(screens[4].render(120).join("\n"), /2 comments/);
	assert.match(screens[4].render(120).join("\n"), /pesap/);
	screens[4].handleInput("\r");
	await nextTurn();
	const comment = screens[5].render(120).join("\n");
	assert.match(comment, /author: pesap \(OWNER\)/);
	assert.match(comment, /source: issue-comment/);
	assert.match(comment, /location: docs\/demo-work\.md:12/);
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
