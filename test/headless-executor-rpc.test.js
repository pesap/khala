import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	buildHeadlessPiArguments,
	createExecutorStarter,
	getHeadlessRuntime,
	HeadlessExecutorRuntime,
	KHALA_HEADLESS_LAUNCHER,
	StrictJsonlReader,
	registerHeadlessRuntime,
	sendHeadlessExecutorMessage,
} from "../dist/src/executor.js";
import { CONCLAVE_TOOL_ALLOWLIST } from "../dist/src/khala-conclave.js";

const CHILD_SCRIPT = `
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function handle(line) {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "session-stable", sessionFile: process.env.SESSION_FILE ?? process.cwd() + "/executor-session.jsonl" } });
  } else if (command.type === "prompt" || command.type === "steer") {
    if (process.env.EMIT_EVENT === "1") emit({ type: "turn_end", execution: "event-visible" });
    const rejected = (command.type === "prompt" && process.env.REJECT_INITIAL_PROMPT === "1") || (command.type === "steer" && process.env.REJECT_STEER === "1");
    emit({ type: "response", id: command.id, command: command.type, success: !rejected, error: rejected ? "rejected " + command.type : undefined });
    if (process.env.EXIT_AFTER_PROMPT === "1" && command.type === "prompt") setTimeout(() => process.exit(9), 20);
  }
}
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));
if (process.env.STDERR_BYTES) process.stderr.write("x".repeat(Number(process.env.STDERR_BYTES)));
`;

const MALFORMED_CHILD_SCRIPT = `
process.stdout.write("not-json\\n");
setInterval(() => {}, 1000);
`;

const EPIPE_CHILD_SCRIPT = `
process.stdin.on("data", () => {
  process.stdin.destroy();
  setTimeout(() => process.exit(0), 5);
});
`;

function createChildFactory(root, starts, environment = {}) {
	return (_command, args, cwd) => {
		starts.push(args);
		const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, "--", ...args], {
			cwd,
			env: { ...process.env, ...environment, EXIT_AFTER_PROMPT: starts.length === 1 ? "1" : "0" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		return child;
	};
}

async function waitFor(predicate, description) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${description}.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function physicalTempPath(root, filename) {
	return join(realpathSync(root), filename);
}

test("RPC framing is LF-only and preserves U+2028 and U+2029", () => {
	const records = [];
	const reader = new StrictJsonlReader((record) => records.push(record));
	reader.push(Buffer.from(JSON.stringify({ type: "response", message: "a b c" }) + "\n"));
	reader.push(Buffer.from(JSON.stringify({ type: "response", message: "last" })));
	reader.end();
	assert.equal(records.length, 2);
	assert.equal(records[0].message, "a b c");
	assert.equal(records[1].message, "last");
});

test("headless arguments select the explicit model and bind restart sessions", () => {
	assert.deepEqual(
		buildHeadlessPiArguments([
				"--provider",
				"wrong-provider",
				"--provider=wrong-provider-equals",
				"--model=wrong/model",
				"--mode",
				"json",
				"--mode=interactive",
				"--session-id",
				"wrong-session-id",
				"--session=/tmp/wrong-session",
				"--fork=/tmp/wrong-fork",
				"--resume",
				"--resume=wrong-resume",
				"--continue",
				"--continue=wrong-continue",
				"--no-session",
				"--no-session=true",
				"--thinking",
				"high",
				"--name",
				"safe-name",
			],
			"provider/executor",
			"/tmp/session.jsonl",
		),
		["--mode", "rpc", "--model", "provider/executor", "--thinking", "high", "--name", "safe-name", "--session", "/tmp/session.jsonl"],
	);
});

test("a real headless runtime gates the single-use stop handoff after settled abort", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-stop-handoff-"));
	const script = `
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function handle(command) {
  if (command.type === "get_state") emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "stop-session", sessionFile: process.cwd() + "/stop-session.jsonl" } });
  else if (command.type === "abort") { emit({ type: "response", id: command.id, command: "abort", success: true }); emit({ type: "agent_settled" }); }
  else if (command.type === "prompt" || command.type === "steer") emit({ type: "response", id: command.id, command: command.type, success: true });
}
process.stdin.on("data", chunk => { buffer += chunk.toString(); let index; while ((index = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) handle(JSON.parse(line)); } });
`;
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission",
			spawnProcess: (_command, args, cwd) => spawn(process.execPath, ["-e", script, "--", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] }),
		});
		await runtime.start();
		runtime.setStopPending();
		await assert.rejects(runtime.sendPrompt("forbidden"), /stop-pending/);
		await assert.rejects(runtime.sendStopHandoff("too early"), /settled stop-pending abort/);
		await runtime.sendAbort();
		await runtime.waitForSettled();
		await runtime.sendStopHandoff("one handoff");
		await assert.rejects(runtime.sendStopHandoff("second handoff"), /single-use/);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RPC rejects prompt and steer responses instead of reporting acceptance", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-rejections-"));
	try {
		const initialFailures = [];
		const initialRuntime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			executionId: "rejected-initial",
			spawnProcess: createChildFactory(root, [], { REJECT_INITIAL_PROMPT: "1" }),
			onFailure: (error) => { initialFailures.push(error.message); },
		});
		await assert.rejects(initialRuntime.start(), /rejected prompt/);
		assert.equal(initialFailures.length, 1);
		await initialRuntime.closeProcess();

		const steerRuntime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: createChildFactory(root, [], { REJECT_STEER: "1" }),
		});
		await steerRuntime.start();
		await assert.rejects(steerRuntime.sendSteer("correction"), /rejected steer/);
		await steerRuntime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("headless RPC forwards native events and drains bounded stderr", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-events-"));
	const events = [];
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: createChildFactory(root, [], { EMIT_EVENT: "1", STDERR_BYTES: "1048576" }),
			onEvent: (event) => { events.push(event); },
		});
		await runtime.start();
		assert.deepEqual(events, [{ type: "turn_end", execution: "event-visible" }]);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("headless Executor becomes ready from get_state and closes by ending its pipe", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-ready-"));
	const starts = [];
	try {
		let binding;
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: createChildFactory(root, starts),
			onReady: (next) => {
				binding = next;
			},
		});
		await runtime.start();
		assert.deepEqual(binding, { sessionId: "session-stable", sessionPath: physicalTempPath(root, "executor-session.jsonl") });
		assert.equal(starts[0].includes("--mode"), true);
		assert.equal(starts[0].includes("rpc"), true);
		assert.equal(starts[0].includes("provider/executor"), true);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("headless RPC accepts a physical session path for a lexical session-path alias", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-session-alias-"));
	const lexicalSessionPath = join(root, "executor-session.jsonl");
	const physicalSessionPath = physicalTempPath(root, "executor-session.jsonl");
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			sessionId: "session-stable",
			sessionPath: lexicalSessionPath,
			spawnProcess: createChildFactory(root, [], { SESSION_FILE: physicalSessionPath }),
		});
		await runtime.start();
		assert.equal(runtime.sessionPath, physicalSessionPath);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RPC restart runs catch-up before accepting same-session live events", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-catch-up-order-"));
	const starts = [];
	const order = [];
	const script = `
let buffer = "";
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function handle(command) {
  if (command.type === "get_state") {
    emit({ type: "response", id: command.id, command: "get_state", success: true, data: { sessionId: "stable", sessionFile: process.cwd() + "/session.jsonl" } });
    if (process.env.PHASE === "2") emit({ type: "live_event" });
  } else if (command.type === "prompt") {
    emit({ type: "response", id: command.id, command: "prompt", success: true });
    if (process.env.PHASE === "1") setTimeout(() => process.exit(9), 10);
  }
}
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: (_command, args, cwd) => {
				starts.push(args);
				return spawn(process.execPath, ["-e", script], {
					cwd,
					env: { ...process.env, PHASE: starts.length === 1 ? "1" : "2" },
					stdio: ["pipe", "pipe", "pipe"],
				});
			},
			onRestart: () => order.push("catch-up"),
			onEvent: (event) => { if ((event).type === "live_event") order.push("live-event"); },
		});
		await runtime.start();
		await waitFor(() => order.length === 2, "restart catch-up and live event");
		assert.deepEqual(order, ["catch-up", "live-event"]);
		assert.equal(starts.length, 2);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unexpected Executor loss restarts the same Pi session", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-restart-"));
	const starts = [];
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: createChildFactory(root, starts),
		});
		await runtime.start();
		await waitFor(() => starts.length === 2, "Executor restart");
		assert.equal(starts[1].includes("--session"), true);
		assert.equal(starts[1].includes(physicalTempPath(root, "executor-session.jsonl")), true);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("malformed JSON and event callback failures stop the child and unregister the runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-failures-"));
	const children = [];
	try {
		let callbackFailure;
		const malformedRuntime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			executionId: "malformed-execution",
			spawnProcess: (_command, args, cwd) => {
				const child = spawn(process.execPath, ["-e", MALFORMED_CHILD_SCRIPT, "--", ...args], {
					cwd,
					stdio: ["pipe", "pipe", "pipe"],
				});
				children.push(child);
				return child;
			},
			onFailure: async (error) => {
				callbackFailure = error;
				throw new Error("failure callback failed");
			},
		});
		registerHeadlessRuntime("malformed-execution", malformedRuntime);
		const malformedStart = malformedRuntime.start();
		await assert.rejects(malformedStart, /JSON|startup|failed/i);
		await malformedRuntime.closeProcess();
		await assert.rejects(sendHeadlessExecutorMessage("malformed-execution", "late"), /No live headless/);
		assert.ok(callbackFailure);
		assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const callbackRoot = mkdtempSync(join(tmpdir(), "khala-rpc-event-failure-"));
	try {
		const failures = [];
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: callbackRoot,
			model: "provider/executor",
			mission: "Mission identity",
			executionId: "callback-execution",
			spawnProcess: createChildFactory(callbackRoot, [], { EMIT_EVENT: "1" }),
			onEvent: () => { throw new Error("event callback failed"); },
			onFailure: (error) => { failures.push(error.message); },
		});
		registerHeadlessRuntime("callback-execution", runtime);
		await assert.rejects(runtime.start(), /event callback failed/);
		await new Promise((resolve) => setTimeout(resolve, 30));
		await runtime.closeProcess();
		assert.equal(failures.length, 1);
		await assert.rejects(sendHeadlessExecutorMessage("callback-execution", "late"), /No live headless/);
	} finally {
		rmSync(callbackRoot, { recursive: true, force: true });
	}
});

test("a replaced runtime that closes late cannot deregister its successor", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-replacement-"));
	try {
		const replaced = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			executionId: "replaced-execution",
			spawnProcess: (_command, args, cwd) =>
				spawn(process.execPath, ["-e", MALFORMED_CHILD_SCRIPT, "--", ...args], {
					cwd,
					stdio: ["pipe", "pipe", "pipe"],
				}),
		});
		const replacement = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			executionId: "replaced-execution",
			spawnProcess: createChildFactory(root, []),
		});
		// Recovery replaces the runtime instance for the same execution ID while the old instance is still closing.
		registerHeadlessRuntime("replaced-execution", replaced);
		registerHeadlessRuntime("replaced-execution", replacement);
		await assert.rejects(replaced.start(), /JSON|startup|failed/i);
		await replaced.closeProcess();
		assert.equal(getHeadlessRuntime("replaced-execution"), replacement);
		await replacement.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stdin EPIPE and child error races settle startup without uncaught errors", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-epipe-"));
	try {
		const epipeRuntime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: (_command, args, cwd) => spawn(process.execPath, ["-e", EPIPE_CHILD_SCRIPT, "--", ...args], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		});
		await assert.rejects(epipeRuntime.start(), /exited|failed|stdin|write/i);
		await epipeRuntime.closeProcess();

		const childErrorRuntime = new HeadlessExecutorRuntime({
			command: "/definitely/missing/pi",
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
		});
		await assert.rejects(childErrorRuntime.start(), /ENOENT|failed|startup/i);
		await childErrorRuntime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("restart rejects a changed session path even when the session ID is stable", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-session-path-"));
	const starts = [];
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: (_command, args, cwd) => {
				starts.push(args);
				return spawn(process.execPath, ["-e", CHILD_SCRIPT, "--", ...args], {
					cwd,
					env: {
						...process.env,
						EXIT_AFTER_PROMPT: starts.length === 1 ? "1" : "0",
						SESSION_FILE: starts.length === 1 ? join(root, "executor-session.jsonl") : join(root, "other-session.jsonl"),
					},
					stdio: ["pipe", "pipe", "pipe"],
				});
			},
			onFailure: (error) => { failures.push(error.message); },
		});
		const failures = [];
		await runtime.start();
		await waitFor(() => failures.length === 1, "restart identity failure");
		assert.match(failures[0] ?? "", /session identity/);
		await runtime.closeProcess();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime loss after a failed restart reports process failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-failure-"));
	const starts = [];
	let failure;
	try {
		const runtime = new HeadlessExecutorRuntime({
			command: process.execPath,
			args: [],
			cwd: root,
			model: "provider/executor",
			mission: "Mission identity",
			spawnProcess: (_command, args, cwd) => {
				starts.push(args);
				if (starts.length > 1) {
					return spawn(process.execPath, ["-e", "process.exit(4)"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
				}
				return spawn(process.execPath, ["-e", CHILD_SCRIPT, "--", ...args], {
					cwd,
					env: { ...process.env, EXIT_AFTER_PROMPT: "1" },
					stdio: ["pipe", "pipe", "pipe"],
				});
			},
			onFailure: (error) => { failure = error; },
		});
		await runtime.start();
		await waitFor(() => failure !== undefined, "restart process failure");
		assert.match(failure?.message ?? "", /exited|failed|unavailable/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the Conclave session activates only the effective supervision tool set", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-conclave-tools-"));
	try {
		const resourceLoader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			additionalExtensionPaths: [join(process.cwd(), "dist/src/index.js")],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			sessionManager: SessionManager.inMemory(root),
			resourceLoader,
			tools: [...CONCLAVE_TOOL_ALLOWLIST],
		});
		assert.deepEqual(session.getActiveToolNames().sort(), [
			"khala_admit_work",
			"khala_apply_user_priority",
			"khala_coordinate_work",
			"khala_dispose_user_priority",
			"khala_launch_execution",
			"khala_launch_observer",
			"khala_read_archive",
			"khala_record_intervention_outcome",
			"khala_record_work_outcome",
			"khala_steer_execution",
			"khala_verdict",
		]);
		await session.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Conclave supervision allowlist excludes implementation and shell tools", () => {
	assert.deepEqual([...CONCLAVE_TOOL_ALLOWLIST], [
		"khala_read_archive",
		"khala_admit_work",
		"khala_launch_observer",
		"khala_launch_execution",
		"khala_verdict",
		"khala_record_work_outcome",
		"khala_steer_execution",
		"khala_coordinate_work",
		"khala_record_intervention_outcome",
		"khala_apply_user_priority",
		"khala_dispose_user_priority",
	]);
	assert.equal(CONCLAVE_TOOL_ALLOWLIST.includes("read"), false);
	assert.equal(CONCLAVE_TOOL_ALLOWLIST.includes("bash"), false);
});

test("mission starter uses a headless runtime without an Executor target", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-rpc-starter-"));
	const fakePi = join(root, "fake-pi");
	writeFileSync(fakePi, `#!/usr/bin/env node\n${CHILD_SCRIPT}`);
	chmodSync(fakePi, 0o755);
	let removed = false;
	let launchName;
	try {
		const starter = createExecutorStarter(
			{
				async createSandbox() { return { path: root, name: "mission", projectPath: root }; },
				async removeSandbox() { removed = true; },
			},
			{ launch: async () => { throw new Error("interactive launcher must not be used"); }, focus: async () => {}, close: async () => {} },
			[fakePi],
			"tmux",
			"provider/executor",
		);
		const launched = await starter({
			projectPath: root,
			workId: "work",
			executionId: "execution",
			name: "Mission",
			executorName: "Executor",
			mission: "Mission",
			systemPrompt: "Executor prompt",
			kind: "executor",
			onSandboxCreated: (_sandbox, name) => { launchName = name; },
		});
		assert.equal(launched.target, undefined);
		assert.equal(launchName, KHALA_HEADLESS_LAUNCHER);
		await launched.cleanup();
		assert.equal(removed, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
