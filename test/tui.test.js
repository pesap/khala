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
					recordNumber: 1,
					id: "record-1",
					kind: "submission",
					actor: "user",
					workId: work.workId,
					payloadVersion: 1,
					summary: "Work submitted",
					evidenceRefs: ["submission evidence"],
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
	assert.match(overview, /Mission\s+in progress/);
	assert.match(overview, /Execution\s+running/);
	assert.match(overview, /Runtime\s+unreachable/);
	assert.doesNotMatch(overview, /mission-1|execution-1/);
	assert.match(overview, /Next\s+Executor runtime is unreachable\. Recover it from Actions\./);
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
	assert.ok(actions.indexOf("Recover") < actions.indexOf("Cancel"));
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
	assert.match(recordDetail, /submission evidence/);
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
	assert.doesNotMatch(unadmittedOverview, /Mission|Execution|Runtime/);
	assert.doesNotMatch(unadmittedOverview, /Conclave admission failed/);
	assert.doesNotMatch(unadmittedOverview, /remediation Open \/khala/);
	screens[11].handleInput("\u007f");
	await nextTurn();
	screens[12].handleInput("\u001b");
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

test("Evidence lists Archive records and exposes provider comments", async () => {
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
		inspectRuntime: async () => work,
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
	assert.match(overview, /Execution\s+running/);
	assert.match(overview, /Runtime\s+unreachable/);
	assert.doesNotMatch(overview, /no active runtime/);
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
	assert.ok(evidence.indexOf("1    observation") < evidence.indexOf("2    delivery"));
	assert.ok(evidence.indexOf("2    delivery") < evidence.indexOf("3    ready"));
	assert.ok(evidence.indexOf("3    ready") < evidence.indexOf("4    review request"));
	assert.match(evidence, /Next\s+Executor runtime is unreachable\. Recover it from Actions\./);
	assert.match(evidence, /Learning\s+Archive learning is authoritative\.\s+Make the runtime constraint explicit\./);
	assert.match(evidence, /Provider observation changed: review-comment/);
	assert.match(evidence, /Authorized provider review feedback was delivered/);
	assert.match(evidence, /Review comments\s+2 available/);
	assert.doesNotMatch(evidence, /Provider summary|Conclave handoff|CI checks/);
	assert.match(evidence, /escape\/ctrl\+c\/backspace back\s+v comments/);
	assert.doesNotMatch(evidence, /select Review comments to explore/);
	const narrowEvidence = screens[2].render(70).join("\n");
	assert.match(narrowEvidence, /SEQ\s+KIND\s+SUMMARY/);
	assert.doesNotMatch(narrowEvidence, /2026-08-25 22:35:00\.000Z/);
	screens[2].handleInput("v");
	await nextTurn();
	assert.match(screens[3].render(120).join("\n"), /Review comments/);
	assert.match(screens[3].render(120).join("\n"), /pesap/);
	screens[3].handleInput("\r");
	await nextTurn();
	const comment = screens[4].render(120).join("\n");
	assert.match(comment, /author: pesap \(OWNER\)/);
	assert.match(comment, /source: issue-comment/);
	assert.match(comment, /location: docs\/demo-work\.md:12/);
	assert.match(comment, /Changes requested: add one sentence to docs\/demo-work\.md/);
	assert.match(comment, /https:\/\/github\.com\/pesap\/khala\/pull\/43#issuecomment-5416846981/);
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b");
	await nextTurn();
	screens[6].handleInput("\u001b");
	await nextTurn();
	screens[7].handleInput("\u001b");
	await nextTurn();
	screens[8].handleInput("\u001b");
	await result;
});

test("Archive lists every record newest first with one heading count", async () => {
	const screens = [];
	const work = {
		workId: "archive-order-work",
		state: "active",
		revision: 3,
		terms: { title: "Archive order" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: { executionId: "execution-1", state: "running", runtimeState: "idle" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Review the latest evidence.",
	};
	const records = [
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
			recordedAt: "2026-01-01T00:00:00Z",
			payload: { title: work.terms.title },
		},
		{
			sequence: 2,
			recordNumber: 2,
			id: "record-2",
			kind: "error",
			actor: "monitor",
			workId: work.workId,
			missionId: work.mission.missionId,
			executionId: work.execution.executionId,
			payloadVersion: 1,
			summary: "Pi runtime closed",
			evidenceRefs: [],
			recordedAt: "2026-01-01T00:01:00Z",
			payload: { summary: "Pi runtime closed" },
		},
		{
			sequence: 3,
			recordNumber: 3,
			id: "record-3",
			kind: "signal",
			actor: "executor",
			workId: work.workId,
			missionId: work.mission.missionId,
			executionId: work.execution.executionId,
			payloadVersion: 1,
			summary: "ready Signal from Executor",
			evidenceRefs: [],
			recordedAt: "2026-01-01T00:02:00Z",
			payload: { kind: "ready", summary: "Ready for review", evidence: [] },
		},
	];
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction }],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({ items: records, asOfSequence: 3 }),
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
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	const archive = screens[2].render(100).join("\n");
	assert.match(archive, /Archive 3 records/);
	assert.ok(archive.indexOf("3    ready") < archive.indexOf("2    error"));
	assert.ok(archive.indexOf("2    error") < archive.indexOf("1    submission"));
	assert.doesNotMatch(archive, /3 Archive records/);
	screens[2].handleInput("\u001b");
	await nextTurn();
	screens[3].handleInput("\u001b");
	await nextTurn();
	screens[4].handleInput("\u001b");
	await result;
});

// oxlint-disable-next-line complexity
test("Work picker stays minimal, shows active Work, and marks failures", async () => {
	const screens = [];
	const inspectedWorkIds = [];
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
		inspectRuntime: async (workId) => {
			inspectedWorkIds.push(workId);
			return {
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
			};
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
	const current = screens[0].render(100).join("\n");
	assert.match(current, /Work/);
	assert.match(current, /Add a compact Khala lifecycle/);
	assert.match(current, /stopped\s+failed/);
	assert.match(current, /active\s+failed/);
	assert.match(current, /failed-wor/);
	assert.match(current, /→\s+Add a compact Khala lifecycle/);
	assert.match(current, /type to filter/);
	assert.doesNotMatch(current, /…/);
	assert.doesNotMatch(current, /completed-work|cancelled-work|scope|Filter Work/);
	const rows = current.split("\n");
	const activeRow = rows.find((line) => line.includes("active-wor"));
	const failedRow = rows.find((line) => line.includes("failed-wor"));
	assert.equal(
		visibleWidth(activeRow?.slice(0, activeRow.indexOf("active-wor")) ?? ""),
		visibleWidth(failedRow?.slice(0, failedRow.indexOf("failed-wor")) ?? ""),
	);
	const narrow = screens[0].render(80).join("\n");
	assert.match(narrow, /EXECUTION/);
	assert.match(narrow, /running/);
	const compact = screens[0].render(40).join("\n");
	const compactHeader = compact.split("\n").find((line) => line.includes("STATE"));
	const compactRow = compact.split("\n").find((line) => line.includes("active"));
	assert.ok(compactHeader);
	assert.ok(compactRow);
	assert.equal(
		visibleWidth(compactHeader.slice(0, compactHeader.indexOf("STATE"))),
		visibleWidth(compactRow.slice(0, compactRow.lastIndexOf("active"))),
	);
	assert.ok(compact.split("\n").every((line) => visibleWidth(line) <= 40));
	const veryNarrow = screens[0].render(30).join("\n");
	assert.doesNotMatch(veryNarrow, /ID/);
	assert.match(veryNarrow, /STATE/);
	assert.match(veryNarrow, /EXECUT/);
	assert.ok(veryNarrow.split("\n").every((line) => visibleWidth(line) <= 30));

	screens[0].handleInput("\u001b[B");
	screens[0].handleInput("\r");
	await nextTurn();
	assert.equal(inspectedWorkIds.at(-1), "execution-failed-work");
	screens[1].handleInput("\u001b");
	await nextTurn();

	for (const character of "lifecycle") screens[2].handleInput(character);
	const filtered = screens[2].render(100).join("\n");
	assert.match(filtered, /active-wor/);
	assert.doesNotMatch(filtered, /execution-failed-work/);
	for (const _character of "lifecycle") screens[2].handleInput("\u007f");
	screens[2].handleInput("\u001b[H");
	const selectedFirst = screens[2].render(100).join("\n");
	assert.match(selectedFirst, /active-wor/);
	assert.doesNotMatch(selectedFirst, /Completed mission to hide|Cancelled Work to hide/);
	screens[2].handleInput("\r");
	await nextTurn();
	screens[3].handleInput("\u001b");
	await nextTurn();
	assert.match(screens[4].render(100).join("\n"), /lifecycle walk/);
	assert.doesNotMatch(screens[4].render(100).join("\n"), /Completed mission to hide|Cancelled Work to hide/);
	screens[4].handleInput("\u001b");
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
					recordNumber: 8,
					missionRecordNumber: 3,
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
	assert.match(overview, /Execution\s+blocked/);
	assert.match(overview, /Runtime\s+finishing current turn/);
	assert.equal((overview.match(/BLOCKED/g) ?? []).length, 0);
	assert.ok(overview.indexOf("Archive") < overview.indexOf("Inspect blocking signal"));
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\u001b[B");
	screens[1].handleInput("\r");
	await nextTurn();
	const blockingDetail = screens[2].render(100).join("\n");
	assert.match(blockingDetail, /Blocked/);
	assert.match(blockingDetail, /Executor response/);
	assert.match(blockingDetail, /The Executor cannot publish under the Mission constraints/);
	assert.match(blockingDetail, /The bounded wait completed successfully/);
	screens[2].handleInput("\u001b");
	await nextTurn();
	screens[3].handleInput("\u001b[B");
	screens[3].handleInput("\r");
	await nextTurn();
	const conciseEvidence = screens[4].render(100).join("\n");
	assert.match(conciseEvidence, /SEQ\s+KIND\s+ACTOR\s+TIME\s+SUMMARY/);
	assert.match(conciseEvidence, /→\s+8\s+blocked\s+executor/);
	assert.match(conciseEvidence, /blocked Signal from Executor/);
	assert.doesNotMatch(conciseEvidence, /Provider summary|Review request|Conclave handoff|CI checks/);
	screens[4].handleInput("\u001b");
	await nextTurn();
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\u001b[B");
	screens[5].handleInput("\r");
	await nextTurn();
	assert.match(screens[6].render(100).join("\n"), /8\s+blocked/);
	screens[6].handleInput("\r");
	await nextTurn();
	const signalDetail = screens[7].render(100).join("\n");
	assert.match(signalDetail, /Blocked signal 8/);
	assert.match(signalDetail, /Record ID\s+record-8/);
	assert.doesNotMatch(signalDetail, /kind: signal/);
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

test("Blocking Signal is hidden unless the current Execution is blocked", async () => {
	const screens = [];
	const work = {
		workId: "running-blocked-signal-work",
		state: "active",
		revision: 1,
		terms: { title: "Running with stale Signal" },
		mission: { missionId: "mission-1" },
		missionState: "active",
		execution: { executionId: "execution-1", state: "running", runtimeState: "working" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Executor is working.",
		lastSignal: {
			signalId: "signal-1",
			executionId: "execution-1",
			kind: "blocked",
			summary: "A stale blocked Signal.",
			evidence: [],
		},
	};
	const service = {
		listWork: () => [
			{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction },
		],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [], asOfSequence: 0 }),
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
	assert.doesNotMatch(screens[1].render(100).join("\n"), /Inspect blocking signal/);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
});

test("Work overview hides runtime state for terminal Executions", async () => {
	const screens = [];
	const work = {
		workId: "terminal-runtime-work",
		state: "active",
		revision: 2,
		terms: { title: "Terminal runtime" },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		execution: { executionId: "execution-1", state: "failed", runtimeState: "unreachable" },
		nextAction: "Replace the failed Execution.",
	};
	const service = {
		listWork: () => [
			{ workId: work.workId, title: work.terms.title, state: work.state, executionState: work.execution.state, nextAction: work.nextAction },
		],
		inspectRuntime: async () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [], asOfSequence: 0 }),
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
	const overview = screens[1].render(100).join("\n");
	assert.match(overview, /Execution\s+failed/);
	assert.doesNotMatch(overview, /Runtime/);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
});

test("Role settings open with r and use the native model selector", async () => {
	initTheme();
	const screens = [];
	const selections = [
		"Conclave: provider/conclave (medium)",
		"Model: provider/conclave",
		"Conclave: provider/fallback (medium)",
		"Thinking: medium",
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
	assert.match(screens[3].render(100).join("\n"), /Status\s+in progress/);
	assert.match(screens[3].render(100).join("\n"), /Progress\s+restoring\s+Restoring the Executor/);
	assert.match(screens[3].render(100).join("\n"), /recovery is in progress/);
	screens[3].handleInput("\u001b");
	assert.equal(screens.length, 4);
	resolveRecovery();
	await nextTurn();
	assert.match(screens[3].render(100).join("\n"), /Status\s+succeeded/);
	assert.match(screens[3].render(100).join("\n"), /Progress\s+complete/);
	assert.match(screens[3].render(100).join("\n"), /No action is needed/);
	assert.deepEqual(effects, ["processed"]);
	screens[3].handleInput("\u001b");
	await nextTurn();
	assert.match(screens[4].render(100).join("\n"), /Recoverable Executor[\s\S]*Work\s+active/);
	assert.match(screens[4].render(100).join("\n"), /Execution\s+running/);
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
