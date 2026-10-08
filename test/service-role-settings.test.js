import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeService } from "./helpers/mvp-fixtures.mjs";

test("Conclave invocation mode is validated and reflected in role settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-role-settings-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	try {
		assert.equal(service.getRoleSettings().conclave.mode, "headless");
		service.updateRoleSetting("conclave", "mode", "subagent");
		assert.equal(service.getRoleSettings().conclave.mode, "subagent");
		assert.throws(() => service.updateRoleSetting("conclave", "mode", "interactive"), /headless or subagent/);
		assert.throws(() => service.updateRoleSetting("executor", "mode", "subagent"), /Only Conclave/);
		assert.equal(service.getRoleSettings().conclave.mode, "subagent");
	} finally {
		await service.close();
		await rm(directory, { recursive: true, force: true });
	}
});
