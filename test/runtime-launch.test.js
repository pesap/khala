import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";

async function createPiFixture(t, version) {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-version-"));
	const script = join(directory, "pi.mjs");
	await writeFile(
		script,
		`import readline from "node:readline";
if (process.argv.includes("--version")) {
 process.stdout.write(process.env.PI_OFFLINE === "1" && process.env.KHALA_VERSION_CHECK_SECRET === undefined ? ${JSON.stringify(version)} : "unexpected\\n");
 process.exit(0);
}
const sessionPath = process.argv[process.argv.indexOf("--session") + 1];
readline.createInterface({ input: process.stdin }).on("line", line => {
 const request = JSON.parse(line);
 if (request.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "version-session", sessionFile: sessionPath, isStreaming: false } }) + "\\n");
});
`,
	);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script] });
	t.after(async () => {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, runtime };
}

const sessionInput = {
	model: "model",
	thinking: "low",
	role: "executor",
	promptIdentity: { packageVersion: "1", promptSha256: "version-test" },
	tools: [],
};

test("native Pi accepts exactly 1.1.0 and scrubs the version-check environment", async (t) => {
	const { directory, runtime } = await createPiFixture(t, "1.1.0");
	const secretKey = "KHALA_VERSION_CHECK_SECRET";
	const previousSecret = process.env[secretKey];
	process.env[secretKey] = "must-not-leak";
	try {
		const binding = await runtime.ensureSession({ cwd: directory, ...sessionInput });
		assert.equal(binding.sessionId, "version-session");
	} finally {
		if (previousSecret === undefined) delete process.env[secretKey];
		else process.env[secretKey] = previousSecret;
	}
});

test("native Pi rejects an unsupported version before launching a session", async (t) => {
	const { directory, runtime } = await createPiFixture(t, "1.0.0");
	await assert.rejects(runtime.ensureSession({ cwd: directory, ...sessionInput }), /expected 1\.1\.0, received 1\.0\.0/);
});
