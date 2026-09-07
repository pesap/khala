import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

test("compiled entry points receive package metadata, role prompts, and the demo fixture", async () => {
	execFileSync(process.execPath, [fileURLToPath(new URL("scripts/copy-runtime-assets.mjs", root))], { cwd: root });
	for (const path of ["package.json", "system-prompts/executor.md", "data/fixtures/khala-demo.sqlite"]) {
		assert.deepEqual(await readFile(new URL(`dist/${path}`, root)), await readFile(new URL(path, root)));
	}
});
