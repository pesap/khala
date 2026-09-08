import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiRpcRuntime } from "../dist/src/runtime.js";

const projectRoot = new URL("..", import.meta.url).pathname;
const piCommand = join(projectRoot, "node_modules", ".bin", "pi");

test("native dispatch starts only the explicit Khala extension", async () => {
	const agentDirectory = await mkdtemp(join(tmpdir(), "khala-native-agent-"));
	const projectDirectory = await mkdtemp(join(tmpdir(), "khala-native-project-"));
	const marker = join(agentDirectory, "unexpected-startup");
	const rogue = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded");\n`;
	await mkdir(join(agentDirectory, "extensions"), { recursive: true });
	await mkdir(join(agentDirectory, "prompts"), { recursive: true });
	await mkdir(join(agentDirectory, "skills", "rogue"), { recursive: true });
	await mkdir(join(agentDirectory, "themes"), { recursive: true });
	await mkdir(join(projectDirectory, ".pi", "extensions"), { recursive: true });
	await writeFile(join(agentDirectory, "extensions", "rogue.ts"), rogue);
	await writeFile(join(agentDirectory, "prompts", "rogue.md"), "unexpected prompt");
	await writeFile(join(agentDirectory, "skills", "rogue", "SKILL.md"), "unexpected skill");
	await writeFile(join(agentDirectory, "themes", "rogue.json"), "{}");
	await writeFile(join(agentDirectory, "AGENTS.md"), "unexpected context");
	await writeFile(join(projectDirectory, ".pi", "extensions", "rogue.ts"), rogue);
	await writeFile(join(projectDirectory, "AGENTS.md"), "unexpected project context");

	const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDirectory;
	const runtime = new PiRpcRuntime({
		projectPath: projectDirectory,
		command: [piCommand],
		extensionPath: join(projectRoot, "src", "index.ts"),
		rpcTimeoutMs: 10_000,
	});
	try {
		const binding = await runtime.ensureSession({
			cwd: projectDirectory,
			model: "anthropic/claude-sonnet-4-20250514",
			thinking: "off",
			role: "executor",
			promptIdentity: { packageVersion: "test", promptSha256: "test" },
			tools: [],
		});
		assert.equal(await readFile(marker, "utf8").catch(() => undefined), undefined);
		await runtime.requestStop(binding);
	} finally {
		await runtime.close();
		if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
	}
});

test("native dispatch rejects an unsupported Pi version before role spawn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-native-version-"));
	const invocation = join(directory, "invocations");
	const roleSpawn = join(directory, "role-spawned");
	const script = join(directory, "fake-pi.mjs");
	await writeFile(
		script,
		`import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(invocation)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("--version")) { console.log("0.84.0"); process.exit(0); }
writeFileSync(${JSON.stringify(roleSpawn)}, "spawned");
setInterval(() => {}, 1000);
`,
	);
	const runtime = new PiRpcRuntime({ projectPath: directory, command: [process.execPath, script] });
	try {
		await assert.rejects(
			runtime.ensureSession({
				cwd: directory,
				model: "test/model",
				thinking: "off",
				role: "executor",
				promptIdentity: { packageVersion: "test", promptSha256: "test" },
				tools: [],
			}),
			/Unsupported Pi native version: expected 0\.85\.0, received 0\.84\.0/,
		);
		assert.equal(await readFile(roleSpawn, "utf8").catch(() => undefined), undefined);
		assert.equal((await readFile(invocation, "utf8")).trim(), "--version");
	} finally {
		await runtime.close();
		await rm(directory, { recursive: true, force: true });
	}
});
