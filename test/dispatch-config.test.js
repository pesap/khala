import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../dist/src/config.js";

test("dispatch limits have explicit native service defaults", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-dispatch-config-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const config = loadConfig(directory, false, false);
		assert.equal(config.maxConcurrentRuns, 2);
		assert.equal(config.maxCorrections, 3);
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});

test("dispatch limits are validated independently", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-dispatch-config-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(join(directory, "khala.json"), JSON.stringify({ maxConcurrentRuns: 0 }));
		assert.throws(() => loadConfig(directory, false, false), /maxConcurrentRuns must be a positive integer/);
		await writeFile(join(directory, "khala.json"), JSON.stringify({ maxCorrections: 0 }));
		assert.throws(() => loadConfig(directory, false, false), /maxCorrections must be a positive integer/);
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});
