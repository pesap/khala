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

test("Oracle live phases advance monotonically from real JSON events and finish only on accepted output", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-phases-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const events = [
		{ type: "agent_start" },
		{ type: "agent_start" },
		{ type: "unknown_event" },
		{ type: "turn_start" },
		{ type: "message_update", assistantMessageEvent: { type: "text_start" } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "y" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_end" } },
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Findings:\nVerdict: pass" }] },
		},
		{ type: "agent_end" },
	];
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
${events.map((event) => `process.stdout.write(${JSON.stringify(JSON.stringify(event))} + "\\n");`).join("\n")}
});
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
		const progress = [];
		const result = await runOracle(root, "Review packet", undefined, {
			projectTrusted: false,
			onProgress: (update) => progress.push(update),
		});
		assert.equal(result.output, "Findings:\nVerdict: pass");
		assert.ok(progress.length >= 12, `expected at least 12 progress updates, got ${progress.length}`);
		let previousPhase = -1;
		for (const update of progress) {
			assert.ok(update.phase >= previousPhase, `phase regressed to ${update.phase}`);
			previousPhase = update.phase;
		}
		assert.equal(progress[0].phase, 0);
		assert.equal(progress.at(-1).phase, 4);
		const trace = progress.at(-1).trace;
		assert.deepEqual(trace, ["Prepare context", "Read packet", "Review evidence", "Deliver verdict"]);
		assert.equal(new Set(trace).size, trace.length);
		assert.equal(trace.filter((entry) => entry === "Read packet").length, 1);
		assert.equal(trace.filter((entry) => entry === "Review evidence").length, 1);
		const delivered = progress.find((update) => update.message === "Final review delivered; confirming the verdict.");
		assert.equal(delivered.phase, 3);
		assert.equal(delivered.trace.includes("Deliver verdict"), false);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle preserves usable verdict-less output without completing Deliver verdict", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-no-verdict-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "The review ended early." }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
});
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
		const progress = [];
		const result = await runOracle(root, "Review packet", undefined, {
			projectTrusted: false,
			onProgress: (update) => progress.push(update),
		});
		assert.equal(result.output, "The review ended early.");
		assert.ok(progress.at(-1).phase < 4, "Deliver verdict must not complete without a parsed verdict");
		assert.equal(progress.at(-1).trace.includes("Deliver verdict"), false);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle reconstructs ordered text blocks so trailing content cannot falsely complete the verdict", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-multi-block-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
  { type: "text", text: " " },
  { type: "text", text: "Findings:\\nVerdict: pass" },
  { type: "image", image: "ignored non-text entry" },
  { type: "text", text: "Handoff note: evidence was cut off before confirmation." }
] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
});
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
		const progress = [];
		const result = await runOracle(root, "Review packet", undefined, {
			projectTrusted: false,
			onProgress: (update) => progress.push(update),
		});
		assert.equal(
			result.output,
			" \nFindings:\nVerdict: pass\nHandoff note: evidence was cut off before confirmation.",
		);
		assert.ok(progress.at(-1).phase < 4, "an earlier verdict block must not complete Deliver verdict");
		assert.equal(progress.at(-1).trace.includes("Deliver verdict"), false);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle completes Deliver verdict only when the final output line is the verdict", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-final-line-verdict-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Findings:\\nVerdict: pass\\nHandoff note for the human reviewer." }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
});
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
		const progress = [];
		const result = await runOracle(root, "Review packet", undefined, {
			projectTrusted: false,
			onProgress: (update) => progress.push(update),
		});
		assert.equal(result.output, "Findings:\nVerdict: pass\nHandoff note for the human reviewer.");
		assert.ok(progress.at(-1).phase < 4, "an earlier verdict line must not complete Deliver verdict");
		assert.equal(progress.at(-1).trace.includes("Deliver verdict"), false);
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle keeps a whitespace-only block between No findings. and the verdict noncanonical", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-whitespace-block-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
  { type: "text", text: "Findings:\\nNo findings." },
  { type: "text", text: " " },
  { type: "text", text: "Verdict: pass" }
] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
});
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
		const progress = [];
		const result = await runOracle(root, "Review packet", undefined, {
			projectTrusted: false,
			onProgress: (update) => progress.push(update),
		});
		assert.equal(result.output, "Findings:\nNo findings.\n \nVerdict: pass");
		assert.equal(progress.at(-1).phase, 4, "the final verdict line still completes Deliver verdict");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle preserves leading whitespace before an exact Findings heading", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-leading-whitespace-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
  { type: "text", text: " " },
  { type: "text", text: "Findings:\\nNo findings.\\nVerdict: pass" }
] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
});
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
		assert.equal(result.output, " \nFindings:\nNo findings.\nVerdict: pass");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle preserves a multibyte character split across stdout pipe chunks", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-split-utf8-stdout-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Findings:\\nVerdict: pass \\u{1D518}" }] } }) + "\\n";
const bytes = Buffer.from(line, "utf8");
const boundary = bytes.indexOf(Buffer.from("\\u{1D518}", "utf8")) + 2;
process.stdout.write(bytes.subarray(0, boundary));
setTimeout(() => process.stdout.write(bytes.subarray(boundary)), 50);
});
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
		assert.equal(result.output, "Findings:\nVerdict: pass \u{1D518}");
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});

test("Oracle preserves a split multibyte stderr diagnostic from a failing child", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-oracle-split-utf8-stderr-"));
	const agentDir = join(root, "agent");
	const fakePi = join(root, "pi");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			fakePi,
			`#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
const bytes = Buffer.from("\\u{1D518}\\n", "utf8");
const boundary = bytes.indexOf(Buffer.from("\\u{1D518}", "utf8")) + 2;
process.stderr.write(bytes.subarray(0, boundary));
setTimeout(() => {
process.stderr.write(bytes.subarray(boundary));
process.exitCode = 1;
}, 50);
});
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
		await assert.rejects(runOracle(root, "Review packet", undefined), (error) => {
			assert.ok(error.message.includes("\u{1D518}"), `stderr character preserved: ${error.message}`);
			assert.doesNotMatch(error.message, /\uFFFD/, "no replacement characters in the diagnostic");
			return true;
		});
	} finally {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	}
});
