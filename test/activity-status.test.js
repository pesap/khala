import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";
import { ApplicationService } from "../dist/src/service.js";

const authority = generateKeyPairSync("ed25519");
const rolePublicKey = authority.publicKey.export({ type: "spki", format: "der" }).toString("base64url");

function createService(path, onConclaveSend) {
	return new ApplicationService(
		new SQLiteArchive(path),
		{
			workspace: {},
			codeHost: {},
			runtime: {
				async ensureSession() {
					return { sessionId: "conclave", sessionPath: "/tmp/conclave.jsonl" };
				},
				send: onConclaveSend,
				async getState() {
					return "idle";
				},
				async requestStop() {},
				async close() {},
			},
			models: {
				listScoped() {
					return ["test/conclave"];
				},
				resolve(model) {
					return { model, supportedThinking: ["medium"] };
				},
			},
			oracle: {},
		},
		{
			projectPath: dirname(path),
			targetBranch: "main",
			maxConcurrentExecutions: 1,
			defaultWorkTokens: 100,
			conclaveModel: "test/conclave",
			conclaveThinking: "medium",
			executorModel: "test/executor",
			executorThinking: "medium",
			oracleModel: "test/oracle",
			oracleThinking: "medium",
			observerModel: "test/observer",
			observerThinking: "medium",
			conclavePromptIdentity: { packageVersion: "test", promptSha256: "conclave" },
			executorPromptIdentity: { packageVersion: "test", promptSha256: "executor" },
			observerPromptIdentity: { packageVersion: "test", promptSha256: "observer" },
			oraclePromptIdentity: { packageVersion: "test", promptSha256: "oracle" },
			rolePublicKey,
			autonomousMonitor: false,
		},
	);
}

test("a live Conclave wake reports Khala activity", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-activity-status-"));
	let beginWake = () => undefined;
	const wakeStarted = new Promise((resolve) => {
		beginWake = resolve;
	});
	let releaseWake = () => undefined;
	const service = createService(join(directory, "archive.sqlite"), async () => {
		return new Promise((resolve) => {
			releaseWake = () => resolve({ output: "" });
			beginWake();
		});
	});
	try {
		service.submitWork(
			{ title: "Show status", objective: "Show live activity", acceptanceCriteria: ["The status changes"] },
			{ actor: "user", commandId: "activity-status:submit", expectedWorkRevision: 0, schemaVersion: 1 },
		);
		assert.equal(service.hasLiveActivity(), false);
		const processing = service.processPendingEffects();
		await wakeStarted;
		assert.equal(service.hasLiveActivity(), true);
		releaseWake();
		await processing;
		assert.equal(service.hasLiveActivity(), false);
	} finally {
		releaseWake();
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
