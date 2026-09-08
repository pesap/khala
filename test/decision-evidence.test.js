import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { createDecisionEvidencePacket } from "../dist/src/decision-evidence.js";
import extension from "../dist/src/index.js";

function projection(workId, revision, evidence = {}) {
	return {
		workId,
		revision,
		state: "active",
		terms: {
			title: "Decision work",
			objective: "Diagnose the failure",
			context: "context",
			scope: "scope",
			acceptanceCriteria: ["The diagnosis is recorded"],
			constraints: [],
			validation: ["npm run check"],
			allowedPaths: ["src"],
			maxTokens: 100,
		},
		budget: { maxTokens: 100, reservedTokens: 0, consumedTokens: 0 },
		nextAction: "Inspect the evidence",
		queuedSequence: 0,
		...evidence,
	};
}

function record(workId, revision, kind, payload, summary = "diagnosis") {
	return {
		commandId: `${kind}-${revision}`,
		expectedWorkRevision: revision - 1,
		kind,
		actor: "executor",
		workId,
		payloadVersion: 1,
		summary,
		payload,
		projection: projection(workId, revision, kind === "signal" ? { lastSignal: payload } : {}),
	};
}

test("decision packet preserves diagnoses and excludes capabilities within UTF-8 bounds", () => {
	const packet = createDecisionEvidencePacket({
		works: [projection("work-1", 3, {
			lastSignal: { signalId: "signal-1", executionId: "execution-1", kind: "blocked", summary: "ENOTCACHED: npm cache is offline", evidence: ["npm ci failed: ENOTCACHED"], observedAt: "now" },
			lastValidation: { executionId: "execution-1", headCommit: "head-42", results: [{ command: "npm run check", passed: false, output: "TypeScript failed" }] },
			lastError: { code: "external-failure", summary: "Provider unavailable", retryable: true, remediation: "Inspect provider status", evidenceRefs: ["record-1"] },
		})],
		records: { items: [{
			id: "record-1", sequence: 1, recordNumber: 1, kind: "error", actor: "system", workId: "work-1",
			payloadVersion: 1, summary: "Provider unavailable", evidenceRefs: [], recordedAt: "now",
			payload: { message: "Diagnosis: ENOTCACHED", capabilityNonce: "do-not-show", transcript: "do-not-show", secret: "apiKey=abc123" },
		}], asOfSequence: 1 },
	});
	const text = JSON.stringify(packet);
	assert.ok(Buffer.byteLength(text, "utf8") <= 24_000);
	assert.match(text, /ENOTCACHED/);
	assert.match(text, /head-42/);
	assert.match(text, /Provider unavailable/);
	assert.doesNotMatch(text, /do-not-show|abc123/);
	assert.equal(packet.freshness.atomic, false);
	assert.match(packet.records.untrustedText, /untrusted evidence/);
});

test("malicious metadata, arrays, and depth stay bounded without losing critical diagnostics", () => {
	const huge = "界".repeat(20_000);
	const payload = { summary: "trusted failure", evidence: ["diagnostic"], metadata: { huge, deep: { deeper: { secret: "do-not-show" } } }, work: Array(20_000).fill(huge) };
	const packet = createDecisionEvidencePacket({
		works: [projection("work-deep", 7, { lastSignal: { signalId: "sig-deep", executionId: "exec-deep", kind: "blocked", summary: "blocked by diagnostic", evidence: ["diagnostic"], observedAt: "now" } })],
		records: { items: [{ id: "record-deep", sequence: 1, recordNumber: 1, kind: "assessment", actor: "observer", workId: "work-deep", payloadVersion: 1, summary: "trusted failure", evidenceRefs: [], recordedAt: "now", payload }], nextCursor: "cursor-deep", asOfSequence: 1 },
	});
	assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 24_000);
	assert.match(JSON.stringify(packet), /trusted failure|diagnostic/);
	assert.doesNotMatch(JSON.stringify(packet), /do-not-show|界界界界界/);
	assert.equal(packet.records.items[0].id, "record-deep");
	assert.equal(packet.omissions.some((item) => item.kind === "records" && item.continuation === "cursor-deep"), true);
});

test("allowlisted recursive fields terminate and error payload diagnostics survive", () => {
	let nested = { summary: "leaf" };
	for (let depth = 0; depth < 10_000; depth++) nested = { summary: nested };
	const packet = createDecisionEvidencePacket({
		works: [],
		records: { items: [{ id: "record-recursive", sequence: 1, recordNumber: 1, kind: "error", actor: "system", workId: "work-1", payloadVersion: 1, summary: "Preparation failed", evidenceRefs: [], recordedAt: "now", payload: { message: "ENOTCACHED actual cause", learning: nested } }], nextCursor: "next", asOfSequence: 1 },
	});
	assert.match(JSON.stringify(packet), /ENOTCACHED actual cause/);
	assert.match(JSON.stringify(packet), /nesting bound/);
	assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 24_000);
	assert.equal(packet.omissions[0].omittedCount, 0);
});

test("decision evidence distinguishes passing commands from failed source verification", () => {
	const validation = {
		executionId: "execution-source",
		headCommit: "validated-head",
		sourceVerified: false,
		sourceFailure: "Validation changed greeting.txt; commit the intended source and rerun validation.",
		results: [{ command: "check-greeting", passed: true, output: "Command completed successfully" }],
	};
	const packet = createDecisionEvidencePacket({
		works: [projection("work-source", 3, { lastValidation: validation })],
		records: { items: [{
			id: "validation-source", sequence: 3, recordNumber: 3, kind: "validation", actor: "executor",
			workId: "work-source", payloadVersion: 1, summary: "Source verification failed", evidenceRefs: [],
			recordedAt: "now", payload: validation,
		}], asOfSequence: 3 },
	});
	for (const evidence of [packet.work.validation, packet.records.items[0].payload]) {
		assert.equal(evidence.sourceVerified, false);
		assert.match(evidence.sourceFailure, /greeting\.txt/);
		assert.equal(evidence.results[0].passed, true);
		assert.match(evidence.results[0].output, /successfully/);
	}
});

test("registered archive tool returns decision evidence from the authorized service API", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-decision-tool-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	const workId = "registered-work";
	try {
		await writeFile(join(directory, "khala.json"), JSON.stringify({ archiveRoot: join(directory, "archive") }));
		const archivePath = join(directory, "archive", `${createHash("sha256").update(directory).digest("hex").slice(0, 24)}.sqlite`);
		const archive = new SQLiteArchive(archivePath);
		archive.append({ ...record(workId, 1, "error", { message: "ENOTCACHED: npm cache is offline" }), actor: "system", projection: projection(workId, 1, { lastError: { code: "external-failure", summary: "ENOTCACHED: npm cache is offline", retryable: true, remediation: "Prepare the cache", evidenceRefs: [] } }) });
		archive.close();
		const tools = new Map();
		const handlers = new Map();
		const pi = { registerFlag() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on(name, handler) { handlers.set(name, handler); }, getFlag() { return undefined; }, getActiveTools() { return []; }, setActiveTools() {} };
		extension(pi);
		const context = { cwd: directory, isProjectTrusted: () => false, ui: { setStatus() {}, notify() {}, theme: { fg: (_color, text) => text } } };
		await handlers.get("session_start")({}, context);
		const result = await tools.get("khala_read_archive").execute("call-1", { workId, kinds: ["error"] }, new AbortController().signal, undefined, context);
		assert.match(result.content[0].text, /ENOTCACHED/);
		assert.equal(result.details.kind, "khala-decision-evidence");
		assert.equal(result.details.records.items[0].id, result.details.items[0].id);
		assert.notEqual(result.details.records.items[0].id, undefined);
		await handlers.get("session_shutdown")({});
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
