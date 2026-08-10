import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildPiArguments } from "../dist/src/executor.js";
import { KhalaConfigError, loadKhalaConfig } from "../dist/src/khala-config.js";
import {
	chooseNonInteractiveModels,
	createProjectConfigOverrides,
	thinkingChoices,
} from "../dist/src/khala-setup.js";
import { runOracle } from "../dist/src/khala-oracle.js";
import { getSupportedThinkingLevels, isSupportedThinkingLevel } from "../dist/src/khala-thinking.js";

test("thinking capabilities follow Pi metadata semantics", () => {
	const model = { reasoning: true, thinkingLevelMap: { off: "off", low: "low", medium: null, high: undefined } };
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "high"]);
	assert.deepEqual(getSupportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
	assert.deepEqual(
		thinkingChoices({ "provider/selected": { thinkingLevels: ["low"] } }, "provider/selected"),
		["Pi default", "low"],
	);
	assert.deepEqual(thinkingChoices({}, "provider/missing"), []);
	assert.equal(isSupportedThinkingLevel(model, "low"), true);
	assert.equal(isSupportedThinkingLevel(model, "medium"), false);
	assert.equal(isSupportedThinkingLevel({ reasoning: true }, "medium"), true);
	assert.equal(isSupportedThinkingLevel({ reasoning: false }, "low"), false);
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
				conclaveMaxCostUsdPerTurn: 0.25,
				executorModel: "provider/executor",
				executorMaxCostUsdPerTurn: 1,
				oracleModel: "provider/oracle",
				conclaveThinking: "high",
				executorThinking: "low",
				oracleThinking: "xhigh",
				observerThinking: "minimal",
			}),
		);
		const config = loadKhalaConfig();
		assert.equal(config.conclaveModel, "provider/model");
		assert.equal(config.oracleModel, "provider/oracle");
		assert.equal(config.conclaveThinking, "high");
		assert.equal(config.executorThinking, "low");
		assert.equal(config.oracleThinking, "xhigh");
		assert.equal(config.observerThinking, "minimal");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("project setup persists only values that differ from global configuration", () => {
	const globalConfig = {
		piCommand: ["pi", "--offline"],
		conclaveModel: "provider/conclave",
		executorModel: "provider/executor",
		observerThinking: "",
		pullRequestTargetBranch: "",
	};
	const effectiveProjectConfig = {
		...globalConfig,
		executorModel: "provider/project-executor",
		observerThinking: "off",
	};

	assert.deepEqual(createProjectConfigOverrides(globalConfig, effectiveProjectConfig), {
		executorModel: "provider/project-executor",
		observerThinking: "off",
	});
});

test("non-interactive setup rejects thinking unsupported by the selected model", () => {
	assert.throws(
		() =>
			chooseNonInteractiveModels(
				{
					conclaveModel: "provider/conclave",
					executorModel: "provider/executor",
					oracleModel: "provider/oracle",
					observerModel: "provider/observer",
					conclaveThinking: "high",
					executorThinking: "high",
					oracleThinking: "high",
					observerThinking: "off",
				},
				["provider/conclave", "provider/executor", "provider/oracle", "provider/observer"],
				{
					"provider/conclave": { thinkingLevels: ["high"] },
					"provider/executor": { thinkingLevels: ["high"] },
					"provider/oracle": { thinkingLevels: ["off"] },
					"provider/observer": { thinkingLevels: ["off"] },
				},
			),
		/oracleThinking.*not supported/i,
	);
});

test("Oracle refuses to run without a configured model", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-config-"));
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		await assert.rejects(runOracle(root, "Review packet", undefined), /must be configured/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle surfaces model errors instead of hanging or accepting JSON event output", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-process-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], errorMessage: "Codex error: The usage limit has been reached" } }) + "\\n"));
`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(agentDir, "khala.json"),
			JSON.stringify({
				piCommand: [fakePi],
				conclaveModel: "provider/conclave",
				conclaveMaxCostUsdPerTurn: 1,
				executorModel: "provider/executor",
				executorMaxCostUsdPerTurn: 1,
				oracleModel: "provider/oracle",
			}),
		);
		await assert.rejects(runOracle(root, "Review packet", undefined), /Khala Oracle failed: Codex error: The usage limit has been reached/);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle streams oversized JSON events without tripping an aggregate stdout limit", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-large-output-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
const thinking = "x".repeat(70_000);
process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: thinking } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verdict: pass" }] } }) + "\\n");
`,
		);
		chmodSync(fakePi, 0o755);
		writeFileSync(
			join(agentDir, "khala.json"),
			JSON.stringify({
				piCommand: [fakePi],
				conclaveModel: "provider/conclave",
				conclaveMaxCostUsdPerTurn: 1,
				executorModel: "provider/executor",
				executorMaxCostUsdPerTurn: 1,
				oracleModel: "provider/oracle",
			}),
		);
		const result = await runOracle(root, "Review packet", undefined);
		assert.equal(result.output, "Verdict: pass");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid explicit configuration fails instead of silently using defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-invalid-config-"));
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(join(root, "khala.json"), JSON.stringify({ launcher: "not-a-launcher" }));
		assert.throws(
			() => loadKhalaConfig(),
			(error) => {
				assert.equal(error instanceof KhalaConfigError, true);
				assert.match(error.message, /launcher.*zellij.*tmux.*herdr/);
				assert.match(error.message, /npx --yes --silent github:pesap\/khala setup/);
				return true;
			},
		);
		writeFileSync(
			join(root, "khala.json"),
			JSON.stringify({
				conclaveModel: "provider/conclave",
				conclaveMaxCostUsdPerTurn: 0.25,
				executorModel: "provider/executor",
				executorMaxCostUsdPerTurn: 1,
				piCommand: ["claude"],
			}),
		);
		assert.throws(() => loadKhalaConfig(), /only supports Pi child commands/);
		writeFileSync(
			join(root, "khala.json"),
			JSON.stringify({
				conclaveModel: "provider/conclave",
				conclaveMaxCostUsdPerTurn: 0.25,
				executorModel: "provider/executor",
				executorMaxCostUsdPerTurn: 1,
				piCommand: ["PI.CMD"],
			}),
		);
		assert.deepEqual(loadKhalaConfig().piCommand, ["PI.CMD"]);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("missing supervision configuration fails with setup guidance", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-thinking-legacy-"));
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		writeFileSync(join(root, "khala.json"), JSON.stringify({ conclaveModel: "provider/model" }));
		assert.throws(
			() => loadKhalaConfig(),
			/Run `npx --yes --silent github:pesap\/khala setup` to configure Khala/,
		);
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
	assert.ok(observerArgs.includes("--tools"));
	assert.ok(observerArgs.includes("read,grep,find,ls,khala_read_archive,khala_record_learning"));
	const thinkingIndex = observerArgs.indexOf("--thinking");
	assert.equal(observerArgs[thinkingIndex + 1], "low");
	assert.deepEqual(observerArgs.slice(-3), ["--khala-agent-kind", "observer", "do work"]);
	const defaultArgs = buildPiArguments(request, "");
	assert.equal(defaultArgs.includes("--thinking"), false);
});
