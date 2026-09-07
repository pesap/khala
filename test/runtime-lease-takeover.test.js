import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";
import { createRuntimeStorage } from "../dist/src/runtime-storage.js";

const runtimeModulePath = fileURLToPath(new URL("../dist/src/runtime.js", import.meta.url));
const TEST_TIMEOUT_MS = 5_000;

async function exitedLeaderLease() {
	const directory = await mkdtemp(joinTempDirectory("khala-runtime-lease-takeover-"));
	const leaderScript = `${directory}/leader.mjs`;
	const supervisorScript = `${directory}/supervisor.mjs`;
	const bindingPath = `${directory}/binding.json`;
	const failurePath = `${directory}/failure.txt`;
	const readyPath = `${directory}/descendant-ready`;
	const exitPath = `${directory}/exit-leader`;
	const exitedPath = `${directory}/leader-exited`;
	const outputPath = `${directory}/descendant-output`;
	const storage = createRuntimeStorage(directory);
	const sessionPath = storage.persistentSessionPath("executor", "takeover");
	const input = {
		cwd: directory,
		model: "model",
		thinking: "low",
		role: "executor",
		promptIdentity: { packageVersion: "1", promptSha256: "test" },
		tools: [],
		sessionPath,
	};
	const options = {
		projectPath: directory,
		command: [process.execPath, leaderScript],
		baseEnvironment: {
			KHALA_TAKEOVER_READY: readyPath,
			KHALA_TAKEOVER_EXIT: exitPath,
			KHALA_TAKEOVER_EXITED: exitedPath,
			KHALA_TAKEOVER_OUTPUT: outputPath,
		},
		rpcTimeoutMs: 1_000,
		agentTimeoutMs: 500,
	};
	await writeFile(
		leaderScript,
		`import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
const readyPath = process.env.KHALA_TAKEOVER_READY;
const exitPath = process.env.KHALA_TAKEOVER_EXIT;
const exitedPath = process.env.KHALA_TAKEOVER_EXITED;
const outputPath = process.env.KHALA_TAKEOVER_OUTPUT;
const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`import { appendFileSync, writeFileSync } from "node:fs";
const readyPath = process.argv[1];
const outputPath = process.argv[2];
writeFileSync(readyPath, String(process.pid));
setInterval(() => appendFileSync(outputPath, "x"), 10);`)}, readyPath, outputPath], { stdio: "ignore" });
void descendant;
let responded = false;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
 const request = JSON.parse(line);
 if (request.type !== "get_state" || responded) return;
 const ready = setInterval(() => {
  if (!existsSync(readyPath)) return;
  clearInterval(ready);
  responded = true;
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "takeover", sessionFile: ${JSON.stringify(sessionPath)}, isStreaming: false } }) + "\\n");
 }, 5);
});
const stop = setInterval(() => {
 if (!existsSync(exitPath)) return;
 clearInterval(stop);
 writeFileSync(exitedPath, String(process.pid));
 process.exit(0);
}, 5);
`,
	);
	await writeFile(
		supervisorScript,
		`import { writeFileSync } from "node:fs";
import { PiRpcRuntime } from ${JSON.stringify(runtimeModulePath)};
const [directory, leaderScript, sessionPath, bindingPath, failurePath, readyPath, exitPath, exitedPath, outputPath] = process.argv.slice(2);
let runtime;
try {
 runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, leaderScript], baseEnvironment: { KHALA_TAKEOVER_READY: readyPath, KHALA_TAKEOVER_EXIT: exitPath, KHALA_TAKEOVER_EXITED: exitedPath, KHALA_TAKEOVER_OUTPUT: outputPath }, rpcTimeoutMs: 1_000, agentTimeoutMs: 500 });
 const binding = await runtime.ensureSession({ cwd: directory, model: "model", thinking: "low", role: "executor", promptIdentity: { packageVersion: "1", promptSha256: "test" }, tools: [], sessionPath });
 writeFileSync(bindingPath, JSON.stringify(binding));
 process.kill(process.pid, "SIGKILL");
} catch (error) {
 writeFileSync(failurePath, error instanceof Error ? error.message : String(error));
 await runtime?.close().catch(() => undefined);
 process.exit(1);
}
`,
	);
	let supervisor;
	let binding;
	try {
		supervisor = spawn(process.execPath, [supervisorScript, directory, leaderScript, sessionPath, bindingPath, failurePath, readyPath, exitPath, exitedPath, outputPath], {
			stdio: "ignore",
		});
		const bindingText = await waitForEitherFile(bindingPath, failurePath);
		binding = JSON.parse(bindingText);
		await waitForChildExit(supervisor);
		await writeFile(exitPath, "exit");
		await waitForFile(exitedPath);
		await waitForProcessGone(binding.processGroupId);
		const descendantPid = Number(await waitForFile(readyPath));
		assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
		const outputBefore = (await readFile(outputPath, "utf8")).length;
		await delay(50);
		assert.ok((await readFile(outputPath, "utf8")).length > outputBefore);
		return { directory, input, binding, options, storage };
	} catch (error) {
		await cleanupPartialCase(directory, supervisor, binding);
		throw error;
	}
}

async function cleanupPartialCase(directory, supervisor, binding) {
	supervisor?.kill("SIGKILL");
	killProcessGroup(binding?.processGroupId);
	await rm(directory, { recursive: true, force: true });
}

function joinTempDirectory(prefix) {
	return join(tmpdir(), prefix);
}

async function waitForEitherFile(path, failurePath) {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const content = await readIfPresent(path);
		if (content !== undefined) return content;
		const failure = await readIfPresent(failurePath);
		if (failure !== undefined) throw new Error(failure);
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForFile(path) {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const content = await readIfPresent(path);
		if (content !== undefined) return content;
		await delay(10);
	}
	throw new Error(`Timed out waiting for ${path}.`);
}

async function readIfPresent(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function hasErrorCode(error, code) {
	return error?.code === code;
}

async function waitForChildExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

async function waitForProcessGone(processId) {
	const deadline = Date.now() + TEST_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await processIsGone(processId)) return;
		await delay(10);
	}
	throw new Error(`Timed out waiting for process ${processId} to exit.`);
}

async function processIsGone(processId) {
	return process.platform === "linux" ? linuxProcessIsGone(processId) : posixProcessIsGone(processId);
}

async function linuxProcessIsGone(processId) {
	try {
		await stat(`/proc/${processId}`);
		return false;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return true;
		throw error;
	}
}

function posixProcessIsGone(processId) {
	try {
		process.kill(processId, 0);
		return false;
	} catch (error) {
		if (hasErrorCode(error, "ESRCH")) return true;
		throw error;
	}
}

function killProcessGroup(processGroupId) {
	if (processGroupId === undefined) return;
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch (error) {
		if (!hasErrorCode(error, "ESRCH")) throw error;
	}
}

async function cleanupLeaseCase(testCase, runtime) {
	await runtime?.close().catch(() => undefined);
	if (testCase.binding.processGroupId !== undefined) killProcessGroup(testCase.binding.processGroupId);
	await delay(50);
	await rm(testCase.directory, { recursive: true, force: true });
}

test("ensureSession preserves a lease when the leader exited but its process group is live", async (t) => {
	if (process.platform === "win32") return t.skip("Process-group lease ownership is unsupported on Windows.");
	const testCase = await exitedLeaderLease();
	const second = new PiRpcRuntime(testCase.options);
	const secondStorage = createRuntimeStorage(testCase.directory);
	try {
		const leasePath = secondStorage.launchLeasePath(testCase.input.sessionPath);
		const leaseBefore = await readFile(leasePath, "utf8");
		await assert.rejects(second.ensureSession(testCase.input), /already owned/);
		assert.equal(await readFile(leasePath, "utf8"), leaseBefore);
	} finally {
		await cleanupLeaseCase(testCase, second);
	}
});

test("unattached requestStop refuses unproven leader-exited ownership and preserves the lease", async (t) => {
	if (process.platform === "win32") return t.skip("Process-group lease ownership is unsupported on Windows.");
	const testCase = await exitedLeaderLease();
	const second = new PiRpcRuntime(testCase.options);
	const secondStorage = createRuntimeStorage(testCase.directory);
	try {
		const leasePath = secondStorage.launchLeasePath(testCase.input.sessionPath);
		const leaseBefore = await readFile(leasePath, "utf8");
		await assert.rejects(second.requestStop(testCase.binding), /Cannot prove Pi process ownership before termination/);
		assert.equal(await readFile(leasePath, "utf8"), leaseBefore);
	} finally {
		await cleanupLeaseCase(testCase, second);
	}
});
