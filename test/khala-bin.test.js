import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

test("bare Khala invocation shows command help without starting setup", () => {
	const result = runKhala();

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Usage:/);
	assert.match(result.stdout, /khala setup \[flags\]/);
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
