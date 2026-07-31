import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatRetryHandoff } from "../src/khala-work-executor-runtime.js";
import { createGitWorktreeProvider } from "../src/vcs-git-worktree.js";

function git(cwd, args) {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("retry handoff renders the required scope and predecessor PR", () => {
	const message = formatRetryHandoff(
		{
			failedCriteria: ["The regression is covered."],
			completedWork: ["The implementation is preserved."],
			requiredChanges: ["Add the focused test."],
			nonGoals: ["Do not change model selection."],
			validation: ["Run the focused test."],
		},
		{ url: "https://github.com/pesap/khala/pull/16", number: 16, status: "draft" },
	);
	assert.match(message, /Retry Contract:/);
	assert.match(message, /The regression is covered\./);
	assert.match(message, /Supersedes #16/);
	assert.match(message, /pull\/16/);
	assert.match(
		formatRetryHandoff(
			{
				failedCriteria: ["A"],
				completedWork: ["B"],
				requiredChanges: ["C"],
				nonGoals: ["D"],
				validation: ["E"],
			},
			undefined,
		),
		/without a Supersedes link/,
	);
});

test("finalizing a successor closes its predecessor after publishing", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-retry-review-"));
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const worktrees = join(root, "worktrees");
	const bin = join(root, "bin");
	const ghLog = join(root, "gh.jsonl");
	mkdirSync(repo);
	mkdirSync(bin);
	execFileSync("git", ["init", "--bare", "-q", remote]);
	execFileSync("git", ["init", "-q", repo]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "Khala Test"]);
	writeFileSync(join(repo, "README.md"), "test\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-qm", "initial"]);
	git(repo, ["branch", "-M", "main"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-q", "-u", "origin", "main"]);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.KHALA_GH_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({ state: "OPEN", body: "", comments: [] }));\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.KHALA_GH_LOG = ghLog;
	let sandbox;
	try {
		const provider = createGitWorktreeProvider(worktrees, "khala-test/");
		sandbox = await provider.createSandbox({ projectPath: repo, name: "retry" });
		const request = {
			sandbox,
			name: "Retry",
			workId: "work-retry",
			executionId: "execution-retry",
			mission: "Retry the missing regression.",
			publish: true,
			supersedesPullRequestUrl: "https://github.com/pesap/khala/pull/16",
		};
		await provider.prepareReview(request);
		const finalization = await provider.finalizeReview(request, "https://github.com/pesap/khala/pull/17");
		assert.equal(finalization.url, "https://github.com/pesap/khala/pull/17");
		assert.equal(existsSync(ghLog), false);
		await provider.supersedePullRequest(
			"https://github.com/pesap/khala/pull/16",
			"https://github.com/pesap/khala/pull/17",
		);
		const calls = readFileSync(ghLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(calls[0].slice(0, 2), ["pr", "view"]);
		assert.deepEqual(calls[1].slice(0, 2), ["pr", "comment"]);
		assert.deepEqual(calls[2].slice(0, 2), ["pr", "close"]);
	} finally {
		if (sandbox !== undefined) {
			await createGitWorktreeProvider(worktrees, "khala-test/").removeSandbox(sandbox);
		}
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		delete process.env.KHALA_GH_LOG;
		rmSync(root, { recursive: true, force: true });
	}
});
