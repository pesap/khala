import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { GitWorkspace } from "../dist/src/adapter-workspace.js";

const execFileAsync = promisify(execFile);
const BASE_FILES = ["ordinary.txt", "staged.txt", "unstaged.txt", "allowed/old.txt"];

async function git(path, ...args) {
	return (await execFileAsync("git", args, { cwd: path, encoding: "utf8" })).stdout.trim();
}

async function write(path, name, contents) {
	const target = join(path, name);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, contents);
}

async function repository(t) {
	const path = await mkdtemp(join(tmpdir(), "khala-change-inspection-"));
	t.after(() => rm(path, { recursive: true, force: true }));
	await git(path, "init", "--quiet");
	await git(path, "config", "user.name", "Khala Test");
	await git(path, "config", "user.email", "khala@example.test");
	for (const name of BASE_FILES) await write(path, name, "base\n");
	await write(path, ".gitignore", "*.ignored\n");
	await git(path, "add", "--", ".gitignore", ...BASE_FILES);
	await git(path, "commit", "--quiet", "-m", "base");
	return { path, baseCommit: await git(path, "rev-parse", "HEAD") };
}

test("inspectChanges preserves every committed, staged, unstaged, and untracked path", async (t) => {
	const fixture = await repository(t);
	await write(fixture.path, "ordinary.txt", "committed\n");
	await git(fixture.path, "add", "ordinary.txt");
	await git(fixture.path, "mv", "allowed/old.txt", "outside.txt");
	await git(fixture.path, "commit", "--quiet", "-m", "committed changes");

	await write(fixture.path, "staged.txt", "staged\n");
	await git(fixture.path, "add", "staged.txt");
	await write(fixture.path, "staged.txt", "base\n");
	await write(fixture.path, "unstaged.txt", "unstaged\n");
	for (const name of [" leading.txt", "trailing.txt ", "line\nbreak.txt"]) await write(fixture.path, name, "untracked\n");
	await write(fixture.path, "hidden.ignored", "ignored\n");

	const workspace = new GitWorkspace(join(fixture.path, "worktrees"), "khala/");
	const changes = await workspace.inspectChanges(fixture);
	assert.deepEqual(new Set(changes), new Set([
		"ordinary.txt",
		"allowed/old.txt",
		"outside.txt",
		"staged.txt",
		"unstaged.txt",
		" leading.txt",
		"trailing.txt ",
		"line\nbreak.txt",
	]));
	assert.equal(changes.includes("hidden.ignored"), false);
});

test("inspectChanges reports a clean repository when baseCommit is HEAD", async (t) => {
	const fixture = await repository(t);
	const workspace = new GitWorkspace(join(fixture.path, "worktrees"), "khala/");
	assert.deepEqual(await workspace.inspectChanges({ path: fixture.path, baseCommit: "HEAD" }), []);
});
