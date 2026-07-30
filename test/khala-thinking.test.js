import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildPiArguments } from "../src/executor.ts";
import { isSupportedThinkingLevel } from "../src/khala-conclave.ts";
import { loadKhalaConfig } from "../src/khala-config.ts";
import { getSupportedThinkingLevels, thinkingChoices } from "../src/khala-setup.ts";

test("thinking capabilities come from model metadata and unsupported models offer no choices", () => {
	const model = { thinkingLevelMap: { off: "off", low: "low", medium: null, high: undefined } };
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low"]);
	assert.deepEqual(thinkingChoices({ thinkingLevels: ["low"] }), ["Pi default", "low"]);
	assert.deepEqual(thinkingChoices(undefined), []);
	assert.equal(isSupportedThinkingLevel(model, "low"), true);
	assert.equal(isSupportedThinkingLevel(model, "medium"), false);
	assert.equal(isSupportedThinkingLevel({}, "low"), false);
});

test("role-specific thinking settings load independently", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-thinking-config-"));
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "khala.json"),
			JSON.stringify({
				conclaveModel: "provider/model",
				conclaveThinking: "high",
				executorThinking: "low",
				observerThinking: "minimal",
			}),
		);
		const config = loadKhalaConfig();
		assert.equal(config.conclaveModel, "provider/model");
		assert.equal(config.conclaveThinking, "high");
		assert.equal(config.executorThinking, "low");
		assert.equal(config.observerThinking, "minimal");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy config without thinking fields preserves Pi defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-thinking-legacy-"));
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(join(root, "khala.json"), JSON.stringify({ conclaveModel: "provider/model" }));
		const config = loadKhalaConfig();
		assert.equal(config.conclaveThinking, "");
		assert.equal(config.executorThinking, "");
		assert.equal(config.observerThinking, "");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("child Pi arguments propagate only the configured role thinking level", () => {
	const request = {
		projectPath: "/project",
		workId: "work",
		executionId: "execution",
		executorName: "Executor",
		mission: "do work",
		systemPrompt: "system",
	};
	const executorArgs = buildPiArguments(request, "high");
	assert.deepEqual(executorArgs.slice(-3), ["--thinking", "high", "do work"]);
	const observerArgs = buildPiArguments({ ...request, kind: "observer" }, "low");
	assert.deepEqual(observerArgs.slice(-5), ["--thinking", "low", "--khala-agent-kind", "observer", "do work"]);
	const defaultArgs = buildPiArguments(request, "");
	assert.equal(defaultArgs.includes("--thinking"), false);
});
