import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showKhala } from "../dist/src/tui.js";
import { theme, nextTurn } from "./helpers/tui-fixtures.mjs";

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
		inspectWork: () => work,
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

test("Evidence keeps long summaries on one bounded line", async () => {
	const screens = [];
	const work = {
		workId: "bounded-evidence-work",
		state: "submitted",
		revision: 32,
		terms: { title: "Bounded evidence", objective: "Keep evidence summaries readable." },
		budget: { reservedTokens: 0, maxTokens: 100, consumedTokens: 0 },
		nextAction: "Inspect the evidence.",
		lastError: {
			code: "external-failure",
			summary: "Conclave admission failed: Conclave wake returned without recording a durable decision.",
			retryable: false,
			remediation: "Inspect the evidence.",
			evidenceRefs: [],
		},
	};
	const record = {
		sequence: 32,
		recordNumber: 32,
		id: "record-error",
		kind: "error",
		actor: "conclave",
		workId: work.workId,
		payloadVersion: 1,
		summary: work.lastError.summary,
		evidenceRefs: [],
		recordedAt: "2026-09-08T22:22:18.113Z",
		payload: work.lastError,
	};
	const service = {
		listWork: () => [{ workId: work.workId, title: work.terms.title, state: work.state, nextAction: work.nextAction }],
		inspectWork: () => work,
		availableActions: () => [],
		readRecords: () => ({ items: [record], asOfSequence: record.sequence }),
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
	screens[1].handleInput("\r");
	await nextTurn();
	const evidence = screens[2].render(100).join("\n");
	assert.match(evidence, /Conclave admission failed/);
	assert.doesNotMatch(evidence, /^\s+without recording a durable decision\./mu);
	screens[2].handleInput("\u001b");
	await nextTurn();
	screens[3].handleInput("\u001b");
	await nextTurn();
	screens[4].handleInput("\u001b");
	await result;
});

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
		availableActions: () => [],
		inspectWork: (workId) => {
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
	assert.match(current, /failed-wor[^\n]*failed/);
	assert.match(current, /attention\s+failed/);
	assert.match(current, /failed-wor/);
	assert.match(current, /→\s+Add a compact Khala lifecycle/);
	assert.match(current, /type to filter/);
	assert.doesNotMatch(current, /…/);
	assert.doesNotMatch(current, /completed-work|cancelled-work|scope|Filter Work/);
	const rows = current.split("\n");
	const activeRow = rows.find((line) => line.includes("active-wor"));
	const failedRow = rows.find((line) => line.includes("failed-wor"));
	assert.equal(
		visibleWidth(activeRow.slice(0, activeRow.indexOf("active-wor"))),
		visibleWidth(failedRow.slice(0, failedRow.indexOf("failed-wor"))),
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
		inspectWork: () => work,
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
	assert.match(overview, /Work\s+active/);
	assert.match(overview, /Summary\s+Two-minute execution job/);
	assert.match(overview, /Blocker\s+The Executor cannot publish under the Mission constraints\./);
	assert.match(overview, /Next\s+Conclave assessment is pending\./);
	assert.match(overview, /Freshness\s+Saved revision 3/);
	assert.doesNotMatch(overview, /^(?:Execution|Runtime)\s/m);
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
		inspectWork: () => work,
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
		inspectWork: () => work,
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
	assert.match(overview, /Work\s+active/);
	assert.match(overview, /Summary\s+Terminal runtime/);
	assert.match(overview, /Next\s+Replace the failed Execution\./);
	assert.match(overview, /Freshness\s+Saved revision 2/);
	assert.doesNotMatch(overview, /^(?:Execution|Runtime)\s/m);
	screens[1].handleInput("\u001b");
	await nextTurn();
	screens[2].handleInput("\u001b");
	await result;
});
