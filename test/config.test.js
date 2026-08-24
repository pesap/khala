import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, persistRoleSetting } from "../dist/src/config.js";

test("Role settings persist without discarding other Khala configuration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-config-"));
	const previousDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		await writeFile(
			join(directory, "khala.json"),
			JSON.stringify({ targetBranch: "develop", conclaveModel: "old/model", roleSettingsKey: "s" }),
		);
		persistRoleSetting("conclave", "model", "new/model");
		persistRoleSetting("conclave", "thinking", "low");
		const config = JSON.parse(await readFile(join(directory, "khala.json"), "utf8"));
		assert.deepEqual(config, {
			targetBranch: "develop",
			conclaveModel: "new/model",
			conclaveThinking: "low",
			roleSettingsKey: "s",
		});
		assert.equal(loadConfig(directory, false, false).keybindings.roleSettings, "s");
	} finally {
		if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDirectory;
		await rm(directory, { recursive: true, force: true });
	}
});
