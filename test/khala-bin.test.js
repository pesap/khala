import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const projectBin = join(projectRoot, "bin", "khala.js");

function runKhala(args = []) {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-"));
	const result = spawnSync(process.execPath, [projectBin, ...args], {
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent") },
	});
	rmSync(root, { recursive: true, force: true });
	return result;
}

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
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		piStub,
		`#!${process.execPath}\nconsole.log(${JSON.stringify([
			"provider conclave 100K 10K yes yes",
			"provider executor 100K 10K yes yes",
			"provider project-executor 100K 10K yes yes",
			"provider oracle 100K 10K yes yes",
			"provider observer 100K 10K yes yes",
		].join("\n"))});\n`,
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
			observerModel: "provider/observer",
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
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(projectDir, ".pi", "khala.json"), "utf8")), {
			executorModel: "provider/project-executor",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
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
