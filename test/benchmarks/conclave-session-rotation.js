import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createFileConclaveStorage } from "../../dist/src/khala-conclave-storage-file.js";
import { CONCLAVE_MODEL_SESSION_MAX_BYTES } from "../../dist/src/khala-conclave-session-storage.js";

const fixtureBytes = 1024 * 1024 * 1024;
const root = mkdtempSync(join(tmpdir(), "khala-conclave-rotation-benchmark-"));
const projectPath = join(root, "project");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

try {
	const storage = createFileConclaveStorage();
	const initialSessionPath = storage.loadConclaveSession(projectPath).getSessionFile();
	assert.equal(typeof initialSessionPath, "string");
	truncateSync(initialSessionPath, fixtureBytes);
	const sparseFixture = statSync(initialSessionPath);
	const rssBefore = process.memoryUsage.rss();
	const startedAt = performance.now();
	const rotated = storage.loadConclaveSession(projectPath);
	const elapsedMs = performance.now() - startedAt;
	const rssDeltaBytes = process.memoryUsage.rss() - rssBefore;

	assert.notEqual(rotated.getSessionFile(), initialSessionPath);
	assert.equal(rotated.buildSessionContext().messages.length, 0);
	assert.equal(rotated.getEntries().length, 2);

	process.stdout.write(
		`${JSON.stringify(
			{
				fixtureBytes,
				fixtureAllocatedBytes: sparseFixture.blocks * 512,
				rotationThresholdBytes: CONCLAVE_MODEL_SESSION_MAX_BYTES,
				elapsedMs: Number(elapsedMs.toFixed(3)),
				rssDeltaBytes,
			},
			null,
			2,
		)}\n`,
	);
} finally {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(root, { recursive: true, force: true });
}
