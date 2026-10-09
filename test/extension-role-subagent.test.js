import assert from "node:assert/strict";
import { test } from "node:test";
import { issueConclaveCapability } from "../dist/src/runtime-launch.js";
import {
	meta,
	nestedConclaveWorkId,
	restrictedToolViolation,
	sessionRoleForTool,
	withNestedConclaveScope,
} from "../dist/src/extension-role.js";
import { authority } from "./helpers/mvp-fixtures.mjs";

const parentSession = { getFlag: () => undefined };

test("nested Conclave tool calls receive a Work-bound role and cannot widen their tool scope", async () => {
	const capability = issueConclaveCapability(authority.privateKey, "work-nested-scope");
	await withNestedConclaveScope("parent-call", capability, async () => {
		assert.equal(sessionRoleForTool(parentSession, "parent-call/0"), "conclave");
		assert.equal(nestedConclaveWorkId("parent-call/0"), "work-nested-scope");
		assert.equal(
			restrictedToolViolation(parentSession, {
				toolCallId: "parent-call/0",
				toolName: "khala_perform_action",
				input: {},
			}),
			undefined,
		);
		assert.match(
			restrictedToolViolation(parentSession, { toolCallId: "parent-call/1", toolName: "bash", input: {} }),
			/The conclave session cannot use the bash tool/,
		);
		const commandMeta = meta("conclave", "nested:action", 3, "parent-call/0");
		assert.equal(commandMeta.roleToken, capability.roleToken);
		assert.equal(commandMeta.roleNonce, capability.roleNonce);
		assert.equal(commandMeta.boundWorkId, "work-nested-scope");
	});
	assert.equal(sessionRoleForTool(parentSession, "parent-call/0"), "user");
	assert.equal(nestedConclaveWorkId("parent-call/0"), undefined);
	assert.equal(restrictedToolViolation(parentSession, { toolCallId: "parent-call/0", toolName: "bash", input: {} }), undefined);
});
