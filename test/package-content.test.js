import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("npm artifact includes linked documentation and validation helpers", () => {
	const output = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		encoding: "utf8",
	});
	const [artifact] = Object.values(JSON.parse(output));
	const files = new Set(artifact.files.map((file) => file.path));
	for (const path of [
		"docs/architecture.md",
		"docs/getting-started.md",
		"docs/mvp-design.md",
		"docs/references/git-review.md",
		"docs/role-prompts.md",
		"src/validation-isolation.ts",
		"src/validation-worker.js",
	]) {
		assert.ok(files.has(path), `npm artifact is missing ${path}`);
	}
});
