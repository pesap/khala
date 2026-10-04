import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const prototypes = ["orient", "work-draft"];

test("package prompts load in another target cwd and prototypes remain opt-in", async () => {
	const manifest = JSON.parse(await readFile("package.json", "utf8"));
	assert.deepEqual(manifest.pi.prompts, ["./prompts"]);
	const packagePromptPaths = manifest.pi.prompts.map((path) => resolve(path));
	const directory = await mkdtemp(join(tmpdir(), "khala-prompt-contracts-"));
	try {
		const defaultLoader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			additionalPromptTemplatePaths: packagePromptPaths,
		});
		await defaultLoader.reload();
		const defaultCommands = defaultLoader.getPrompts().prompts.map((prompt) => prompt.name).sort();
		assert.deepEqual(defaultCommands, ["fresh-eyes", "git-review"]);
		for (const name of prototypes) {
			assert.ok(!defaultCommands.includes(name), `${name} must not appear in package prompt discovery`);
		}

		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			additionalPromptTemplatePaths: prototypes.map((name) => resolve(`docs/prompt-prototypes/${name}.md`)),
		});
		await loader.reload();
		const loaded = loader.getPrompts();
		assert.deepEqual(
			loaded.prompts.map((prompt) => prompt.name).sort(),
			prototypes,
		);
		for (const prompt of loaded.prompts) {
			assert.ok(prompt.description.length > 0);
			assert.match(prompt.argumentHint ?? "", /<task>|<goal>/);
			assert.match(prompt.content, /\$ARGUMENTS/);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Work draft names no mutation and its output is for approval", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-work-draft-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			additionalPromptTemplatePaths: [resolve("docs/prompt-prototypes/work-draft.md")],
		});
		await loader.reload();
		const [draft] = loader.getPrompts().prompts;
		assert.match(draft.content, /khala_submit_work/);
		assert.match(draft.content, /Do not call/);
		assert.match(draft.content, /User approval/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
