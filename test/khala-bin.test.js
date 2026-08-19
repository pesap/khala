import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceJiti = createJiti(import.meta.url);
const standaloneKhalaConfig = await sourceJiti.import("../src/khala-config.ts");
const projectBin = join(projectRoot, "bin", "khala.js");
// Leave room for the 10-second child discovery timeout plus scheduling delay under concurrent CI load.
const SETUP_SUBPROCESS_TIMEOUT_MS = 15_000;

function runKhala(args = []) {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-"));
	const result = spawnSync(process.execPath, [projectBin, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
	});
	rmSync(root, { recursive: true, force: true });
	return result;
}

async function assertProcessExited(processId, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(processId, 0);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
				return;
			}
			throw error;
		}
		if (Date.now() >= deadline) {
			assert.fail(`Process ${processId} remained alive after ${timeoutMs}ms.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("standalone configuration expands a Windows Pi agent-directory override", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (platformDescriptor === undefined) {
		throw new Error("Node process.platform must be configurable for this platform simulation.");
	}
	try {
		Object.defineProperty(process, "platform", { value: "win32" });
		process.env.PI_CODING_AGENT_DIR = "~\\agent";
		assert.equal(
			standaloneKhalaConfig.getKhalaConfigPath(standaloneKhalaConfig.ConfigScope.global),
			join(homedir(), "agent", "khala.json"),
		);
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
	}
});

test("bare Khala invocation starts setup", () => {
	const result = runKhala();

	assert.equal(result.status, 2);
	assert.match(result.stdout, /Khala setup/);
	assert.match(result.stderr, /Non-interactive setup requires an explicit conclaveModel/);
});

test("help remains available without starting setup", () => {
	const result = runKhala(["--help"]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage:/);
	assert.equal(result.stderr, "");
});

test("explicit setup command exposes its help", () => {
	const result = runKhala(["setup", "--help"]);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /The setup wizard writes khala\.json/);
	assert.equal(result.stderr, "");
});

test("invalid setup arguments fail with an actionable diagnostic", () => {
	const result = runKhala(["setup", "--unknown"]);

	assert.equal(result.status, 2);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /khala: Unknown argument: --unknown/);
});

test("project setup writes only overrides that differ from global configuration", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-project-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const piStub = join(root, "pi");
	const piInvocationLog = join(root, "pi-invocations.jsonl");
	// A provider extension can contribute a listed model without appearing in the
	// resource-disabled RPC capability query.
	const models = [
		{ provider: "provider", id: "conclave", reasoning: true },
		{ provider: "provider", id: "executor", reasoning: true },
		{ provider: "provider", id: "project-executor", reasoning: true },
		{ provider: "provider", id: "oracle", reasoning: true },
		{ provider: "provider", id: "observer", reasoning: true },
	];
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.KHALA_PI_LOG, JSON.stringify(args) + "\\n");\nif (args.includes("--list-models")) {\n  process.stdout.write(${JSON.stringify([
			"provider conclave 100K 10K yes yes",
			"provider executor 100K 10K yes yes",
			"provider project-executor 100K 10K yes yes",
			"provider oracle 100K 10K yes yes",
			"provider observer 100K 10K yes yes",
			"provider plugin-model 100K 10K yes yes",
		].join("\n"))});\n} else {\n  let input = "";\n  process.stdin.setEncoding("utf8");\n  process.stdin.on("data", (chunk) => {\n    input += chunk;\n    const newline = input.indexOf("\\n");\n    if (newline < 0) return;\n    const request = JSON.parse(input.slice(0, newline));\n    if (request.type === "get_available_models") {\n      process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_available_models", success: true, data: { models: ${JSON.stringify(models)} } }) + "\\n");\n    }\n  });\n}\n`,
	);
	chmodSync(piStub, 0o755);
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			piCommand: [piStub],
			conclaveModel: "provider/conclave",
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 2,
			oracleModel: "provider/oracle",
			observerModel: "provider/plugin-model",
		}),
	);
	writeFileSync(
		join(projectDir, ".pi", "khala.json"),
		JSON.stringify({ executorModel: "provider/project-executor", obsoleteSetting: true }),
	);
	try {
		const result = spawnSync(process.execPath, [projectBin, "--project", "--yes"], {
			cwd: projectDir,
			encoding: "utf8",
			env: { ...process.env, KHALA_PI_LOG: piInvocationLog, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(projectDir, ".pi", "khala.json"), "utf8")), {
			executorModel: "provider/project-executor",
		});
		const discoveryInvocations = readFileSync(piInvocationLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(discoveryInvocations.some((arguments_) => arguments_.includes("--list-models")));
		const rpcArguments = discoveryInvocations.find(
			(arguments_) => arguments_.includes("--mode") && arguments_.includes("rpc"),
		);
		assert.ok(rpcArguments);
		for (const flag of [
			"--offline",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		]) {
			assert.ok(rpcArguments.includes(flag), `Model discovery must isolate ${flag}.`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-interactive setup rejects an explicit thinking level when Pi capability discovery fails", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-rpc-unavailable-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const piStub = join(root, "pi");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("--list-models")) {\n  process.stdout.write("provider conclave 100K 10K yes yes\\nprovider executor 100K 10K yes yes\\nprovider oracle 100K 10K yes yes\\n");\n} else {\n  process.exit(1);\n}\n`,
	);
	chmodSync(piStub, 0o755);
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			piCommand: [piStub],
			conclaveModel: "provider/conclave",
			conclaveThinking: "max",
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 2,
			oracleModel: "provider/oracle",
		}),
	);
	try {
		const result = spawnSync(process.execPath, [projectBin, "--project", "--yes"], {
			cwd: projectDir,
			encoding: "utf8",
			timeout: SETUP_SUBPROCESS_TIMEOUT_MS,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, /cannot validate configured conclaveThinking.*capability discovery unavailable/i);
		assert.doesNotMatch(result.stdout, /Done\./);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-interactive setup rejects explicit thinking without returned model metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-rpc-metadata-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const piStub = join(root, "pi");
	const models = [
		{ provider: "provider", id: "executor", reasoning: true },
		{ provider: "provider", id: "oracle", reasoning: true },
	];
	const initialConfig = JSON.stringify({
		piCommand: [piStub],
		conclaveModel: "provider/conclave",
		conclaveThinking: "max",
		conclaveMaxCostUsdPerTurn: 1,
		executorModel: "provider/executor",
		executorMaxCostUsdPerTurn: 2,
		oracleModel: "provider/oracle",
	});
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("--list-models")) {\n  process.stdout.write("provider conclave 100K 10K yes yes\\nprovider executor 100K 10K yes yes\\nprovider oracle 100K 10K yes yes\\n");\n} else {\n  process.stdin.once("data", (chunk) => {\n    const request = JSON.parse(String(chunk));\n    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_available_models", success: true, data: { models: ${JSON.stringify(models)} } }) + "\\n");\n  });\n}\n`,
	);
	chmodSync(piStub, 0o755);
	writeFileSync(join(agentDir, "khala.json"), initialConfig);
	try {
		const result = spawnSync(process.execPath, [projectBin, "--project", "--yes"], {
			cwd: projectDir,
			encoding: "utf8",
			timeout: SETUP_SUBPROCESS_TIMEOUT_MS,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(result.status, 2, result.stderr);
		assert.match(result.stderr, /conclaveThinking.*no capability metadata/i);
		assert.equal(readFileSync(join(agentDir, "khala.json"), "utf8"), initialConfig);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup releases model-discovery streams after a Pi wrapper exits", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-rpc-close-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const piStub = join(root, "pi");
	const models = [
		{ provider: "provider", id: "conclave", reasoning: true, thinkingLevelMap: { max: null } },
		{ provider: "provider", id: "executor", reasoning: true },
		{ provider: "provider", id: "oracle", reasoning: true },
	];
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nimport { spawn } from "node:child_process";\nconst args = process.argv.slice(2);\nif (args.includes("--list-models")) {\n  process.stdout.write("provider conclave 100K 10K yes yes\\nprovider executor 100K 10K yes yes\\nprovider oracle 100K 10K yes yes\\n");\n} else {\n  process.stdin.once("data", (chunk) => {\n    const request = JSON.parse(String(chunk));\n    const response = JSON.stringify({ id: request.id, type: "response", command: "get_available_models", success: true, data: { models: ${JSON.stringify(models)} } }) + "\\n";\n    const relaySource = [\n      "process.stdout.on('error', () => process.exit(0));",\n      "setTimeout(() => {",\n      "process.stdout.write(" + JSON.stringify(response) + ");",\n      "const interval = setInterval(() => process.stdout.write(' '), 10);",\n      "setTimeout(() => { clearInterval(interval); process.exit(0); }, 3000);",\n      "}, 25);",\n    ].join("");\n    const relay = spawn(process.execPath, ["-e", relaySource], { stdio: ["ignore", "inherit", "ignore"] });\n    relay.unref();\n    process.exit(0);\n  });\n}\n`,
	);
	chmodSync(piStub, 0o755);
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			piCommand: [piStub],
			conclaveModel: "provider/conclave",
			conclaveThinking: "max",
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 2,
			oracleModel: "provider/oracle",
		}),
	);
	try {
		const result = spawnSync(process.execPath, [projectBin, "--project", "--yes"], {
			cwd: projectDir,
			encoding: "utf8",
			timeout: SETUP_SUBPROCESS_TIMEOUT_MS,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /conclaveThinking.*not supported/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("setup force-terminates a signal-ignoring model-discovery child", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-rpc-stubborn-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const piStub = join(root, "pi");
	const piProcessIdPath = join(root, "pi-process-id");
	const models = [
		{ provider: "provider", id: "conclave", reasoning: true, thinkingLevelMap: { max: "max" } },
		{ provider: "provider", id: "executor", reasoning: true },
		{ provider: "provider", id: "oracle", reasoning: true },
	];
	let rpcProcessId;
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nif (args.includes("--list-models")) {\n  process.stdout.write("provider conclave 100K 10K yes yes\\nprovider executor 100K 10K yes yes\\nprovider oracle 100K 10K yes yes\\n");\n} else {\n  writeFileSync(process.env.KHALA_PI_PID, String(process.pid));\n  process.stdin.once("data", (chunk) => {\n    const request = JSON.parse(String(chunk));\n    process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "get_available_models", success: true, data: { models: ${JSON.stringify(models)} } }) + "\\n");\n    process.on("SIGTERM", () => {});\n    setInterval(() => {}, 1_000);\n  });\n}\n`,
	);
	chmodSync(piStub, 0o755);
	writeFileSync(
		join(agentDir, "khala.json"),
		JSON.stringify({
			piCommand: [piStub],
			conclaveModel: "provider/conclave",
			conclaveThinking: "max",
			conclaveMaxCostUsdPerTurn: 1,
			executorModel: "provider/executor",
			executorMaxCostUsdPerTurn: 2,
			oracleModel: "provider/oracle",
		}),
	);
	try {
		const result = spawnSync(process.execPath, [projectBin, "--project", "--yes"], {
			cwd: projectDir,
			encoding: "utf8",
			timeout: SETUP_SUBPROCESS_TIMEOUT_MS,
			env: { ...process.env, KHALA_PI_PID: piProcessIdPath, PI_CODING_AGENT_DIR: agentDir },
		});
		rpcProcessId = Number(readFileSync(piProcessIdPath, "utf8"));
		assert.equal(Number.isInteger(rpcProcessId) && rpcProcessId > 0, true);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Done\./);
		await assertProcessExited(rpcProcessId);
	} finally {
		if (rpcProcessId !== undefined) {
			try {
				process.kill(rpcProcessId, "SIGKILL");
			} catch (error) {
				// ESRCH is expected after the assertion; a failing regression leaves
				// only this test-owned child behind for cleanup.
				const errorCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
				if (errorCode !== "ESRCH") {
					throw error;
				}
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi host APIs remain host-provided rather than runtime dependencies", () => {
	const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
	for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(dependency in manifest.dependencies, false);
		assert.equal(manifest.peerDependencies[dependency], "*");
		assert.equal(manifest.peerDependenciesMeta[dependency]?.optional, true);
		assert.equal(typeof manifest.devDependencies[dependency], "string");
	}
});

test("package artifact ships the source-backed CLI without compiled output", () => {
	const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	const [pack] = JSON.parse(result.stdout);
	const paths = pack.files.map((file) => file.path);

	assert.ok(paths.includes("bin/khala.js"));
	assert.ok(paths.includes("src/khala-setup.ts"));
	assert.equal(paths.some((path) => path.startsWith("dist/")), false);
	assert.equal(paths.includes("bin/ts-loader.js"), false);
});
