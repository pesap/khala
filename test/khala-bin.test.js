import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

function createFixture(root, packagePath) {
	mkdirSync(join(packagePath, "bin"), { recursive: true });
	writeFileSync(join(packagePath, "package.json"), '{"type":"module"}\n');
	copyFileSync(new URL("bin/khala.js", projectRoot), join(packagePath, "bin", "khala.js"));
	copyFileSync(new URL("bin/ts-loader.js", projectRoot), join(packagePath, "bin", "ts-loader.js"));
	return () => rmSync(root, { recursive: true, force: true });
}

function runBin(packagePath, args = [], env = process.env) {
	return spawnSync(process.execPath, [join(packagePath, "bin", "khala.js"), ...args], {
		encoding: "utf8",
		env,
	});
}

test("installed bin starts the compiled setup entry without a TypeScript loader", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-compiled-"));
	const packagePath = join(root, "node_modules", "@pesap", "khala");
	const cleanup = createFixture(root, packagePath);
	try {
		const compiledPath = join(packagePath, "dist", "src", "khala-setup.js");
		mkdirSync(dirname(compiledPath), { recursive: true });
		writeFileSync(compiledPath, 'console.log(`compiled:${process.argv.slice(2).join(",")}`);\n');
		const result = runBin(packagePath, ["--help"]);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "compiled:--help");
		assert.doesNotMatch(result.stderr, /experimental-loader|UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
	} finally {
		cleanup();
	}
});

test("installed bin fails actionably when compiled output is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-missing-"));
	const packagePath = join(root, "node_modules", "@pesap", "khala");
	const cleanup = createFixture(root, packagePath);
	try {
		mkdirSync(join(packagePath, ".git"));
		mkdirSync(join(packagePath, "src"));
		writeFileSync(join(packagePath, "src", "khala-setup.ts"), 'console.log("source-loaded");\n');
		const result = runBin(packagePath);

		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /compiled setup entry is missing/);
		assert.doesNotMatch(result.stderr, /source-loaded|experimental-loader|UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
	} finally {
		cleanup();
	}
});

test("source checkout retains its TypeScript developer fallback", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-checkout-"));
	const packagePath = join(root, "khala");
	const cleanup = createFixture(root, packagePath);
	try {
		mkdirSync(join(packagePath, ".git"));
		mkdirSync(join(packagePath, "src"));
		writeFileSync(
			join(packagePath, "src", "khala-setup.ts"),
			'const mode: string = process.argv[2] ?? "none"; console.log(`source:${mode}`);\n',
		);
		const result = runBin(packagePath, ["--dry-run"], { ...process.env, NODE_NO_WARNINGS: "1" });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "source:--dry-run");
	} finally {
		cleanup();
	}
});

test("source checkout prefers current TypeScript over stale compiled setup", () => {
	const root = mkdtempSync(join(tmpdir(), "khala-bin-stale-"));
	const packagePath = join(root, "khala");
	const cleanup = createFixture(root, packagePath);
	try {
		mkdirSync(join(packagePath, ".git"));
		mkdirSync(join(packagePath, "src"));
		mkdirSync(join(packagePath, "dist", "src"), { recursive: true });
		writeFileSync(join(packagePath, "src", "khala-setup.ts"), 'console.log("source-current");\n');
		writeFileSync(join(packagePath, "dist", "src", "khala-setup.js"), 'console.log("compiled-stale");\n');
		const result = runBin(packagePath, [], { ...process.env, NODE_NO_WARNINGS: "1" });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "source-current");
	} finally {
		cleanup();
	}
});
