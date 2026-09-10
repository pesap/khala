import assert from "node:assert/strict";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createNativeTerminal, selectNativeListItem, waitUntil } from "./helpers/native-terminal.mjs";
import { createNativeWorkflowFixture } from "./helpers/native-workflow.mjs";

for (const lost of [true, false]) {
test(`Pi Recover continues the same Execution after its Executor becomes ${lost ? "unreachable" : "idle without a Signal"}`, { timeout: 90_000 }, async () => {
	const options = { idleExecutor: true };
	const fixture = await createNativeWorkflowFixture(options);
	const terminal = createNativeTerminal(fixture);
	const diagnostic = () => JSON.stringify({ screen: terminal.screen(), work: terminal.readWork(), steps: fixture.steps, failures: fixture.failures.map(String) });
	const see = (text) => waitUntil(terminal.screen, (screen) => screen.includes(text), diagnostic);
	try {
		await terminal.start();
		terminal.send("Submit the greeting Work now.");
		const idle = await waitUntil(terminal.readWork, (work) => work?.execution?.runtimeState === "idle" && work.budget.reservedTokens === 0, diagnostic);
		const pid = idle.execution.pi.processGroupId;
		assert.ok(Number.isSafeInteger(pid));
		assert.ok(pid > 1);
		assert.notEqual(pid, process.pid);
		assert.equal(readlinkSync(`/proc/${pid}/cwd`), idle.execution.sandbox.path);
		if (lost) process.kill(pid, "SIGKILL");
		terminal.send("/khala");
		await see("Native greeting");
		terminal.keys("Enter");
		await see("Freshness");
		await selectNativeListItem(terminal, "Refresh runtime", diagnostic);
		await see("Runtime checked");
		await see(lost ? "unreachable" : "idle");
		assert.equal(terminal.readWork().execution.executionId, idle.execution.executionId);
		options.idleExecutor = false;
		fixture.steps.executor = 0;
		terminal.keys("Escape");
		await waitUntil(terminal.screen, (screen) => !screen.includes("Runtime checked") && screen.includes("Freshness"), diagnostic);
		terminal.keys("Enter");
		await waitUntil(terminal.screen, (screen) => /^\s*Actions\s*$/m.test(screen), diagnostic);
		await see("Recover");
		terminal.keys("Enter");
		const reviewed = await waitUntil(terminal.readWork, (work) => work.state === "awaiting-review" && work.budget.reservedTokens === 0, diagnostic);
		assert.equal(reviewed.workId, idle.workId);
		assert.equal(reviewed.mission.missionId, idle.mission.missionId);
		assert.equal(reviewed.execution.executionId, idle.execution.executionId);
		assert.equal(reviewed.execution.sandbox.path, idle.execution.sandbox.path);
		assert.equal(reviewed.execution.pi.sessionId, idle.execution.pi.sessionId);
		assert.equal(reviewed.execution.pi.sessionPath, idle.execution.pi.sessionPath);
		if (lost) assert.notEqual(reviewed.execution.pi.processGroupId, pid);
		else assert.equal(reviewed.execution.pi.processGroupId, pid);
		assert.equal(readFileSync(join(reviewed.execution.sandbox.path, "greeting.txt"), "utf8"), "hello\n");
		assert.ok(reviewed.budget.consumedTokens > idle.budget.consumedTokens);
		assert.equal(reviewed.lastError, undefined);
		assert.deepEqual(fixture.failures, []);
	} finally {
		terminal.close();
		await fixture.close();
	}
});
}
