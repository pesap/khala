import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeConfiguredExecutorReview } from "../dist/src/khala-executor.js";
import { createExecutorRecord } from "../dist/src/khala-executor-registry.js";
import { appendPullRequestRecord, latestPullRequest } from "../dist/src/khala-review.js";
import { formatRetryHandoff } from "../dist/src/khala-work-executor-runtime.js";
import { createGitWorktreeProvider } from "../dist/src/vcs-git-worktree.js";

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

test("Executor worktrees start from the resolved PR target instead of caller HEAD", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-worktree-base-"));
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const publisher = join(root, "publisher");
	const worktrees = join(root, "worktrees");
	mkdirSync(repo);
	execFileSync("git", ["init", "--bare", "-q", remote]);
	execFileSync("git", ["init", "-q", repo]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "Khala Test"]);
	writeFileSync(join(repo, "README.md"), "base\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-qm", "base"]);
	git(repo, ["branch", "-M", "main"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-q", "-u", "origin", "main"]);
	git(repo, ["switch", "-c", "caller"]);
	writeFileSync(join(repo, "caller.txt"), "caller\n");
	git(repo, ["add", "caller.txt"]);
	git(repo, ["commit", "-qm", "caller-only"]);
	execFileSync("git", ["clone", "-q", "--branch", "main", remote, publisher]);
	git(publisher, ["config", "user.email", "test@example.invalid"]);
	git(publisher, ["config", "user.name", "Khala Test"]);
	writeFileSync(join(publisher, "remote.txt"), "remote target\n");
	git(publisher, ["add", "remote.txt"]);
	git(publisher, ["commit", "-qm", "advance target"]);
	git(publisher, ["push", "-q", "origin", "main"]);
	const remoteTarget = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
		encoding: "utf8",
	}).trim();
	assert.notEqual(
		execFileSync("git", ["-C", repo, "rev-parse", "origin/main"], { encoding: "utf8" }).trim(),
		remoteTarget,
	);
	let sandbox;
	try {
		const provider = createGitWorktreeProvider(worktrees, "khala-test/");
		sandbox = await provider.createSandbox({ projectPath: repo, name: "base-check" });
		assert.equal(execFileSync("git", ["-C", sandbox.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), remoteTarget);
	} finally {
		if (sandbox !== undefined) {
			await createGitWorktreeProvider(worktrees, "khala-test/").removeSandbox(sandbox);
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("Executor finalization replaces an unconfirmed supplied URL with the published branch PR", async () => {
	const root = mkdtempSync(join(tmpdir(), "khala-confirm-review-"));
	const agentDir = join(root, "agent");
	const repo = join(root, "repo");
	const remote = join(root, "remote.git");
	const bin = join(root, "bin");
	mkdirSync(repo);
	mkdirSync(bin);
	execFileSync("git", ["init", "--bare", "-q", remote]);
	execFileSync("git", ["init", "-q", repo]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "user.name", "Khala Test"]);
	writeFileSync(join(repo, "README.md"), "base\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-qm", "base"]);
	git(repo, ["branch", "-M", "main"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-q", "-u", "origin", "main"]);
	git(repo, ["switch", "-c", "khala/review"]);
	writeFileSync(join(repo, "change.txt"), "change\n");
	git(repo, ["add", "change.txt"]);
	git(repo, ["commit", "-qm", "change"]);
	writeFileSync(
		join(bin, "gh"),
		`#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args[0] === "pr" && args[1] === "list") process.stdout.write(JSON.stringify([{ url: "https://github.com/pesap/khala/pull/42", number: 42 }]));\n`,
	);
	chmodSync(join(bin, "gh"), 0o755);
	const previousPath = process.env.PATH;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const execution = createExecutorRecord({
			executionId: "execution-confirm-review",
			workId: "work-confirm-review",
			executorName: "Review Executor",
			projectPath: repo,
			sandboxPath: repo,
			launcher: "tmux",
		});
		appendPullRequestRecord(
			repo,
			{
				pullRequestId: "unconfirmed-pr",
				workId: execution.workId,
				missionId: "mission-confirm-review",
				executionId: execution.executionId,
				status: "draft",
				url: "https://github.com/attacker/other/pull/9",
				sourceBranch: "khala/review",
				targetBranch: "main",
				planningCommit: "planning",
				changedFiles: [],
				diffSummary: "",
				validationResults: [],
				reviewFeedback: [],
				unresolvedGaps: [],
				recordedAt: new Date().toISOString(),
			},
			false,
		);
		await finalizeConfiguredExecutorReview({
			execution,
			workId: execution.workId,
			projectTrusted: false,
			summary: "Validated",
			evidence: ["focused test"],
		});
		const review = latestPullRequest(repo, execution.executionId, false);
		assert.equal(review.url, "https://github.com/pesap/khala/pull/42");
		assert.ok(review.remoteConfirmedAt);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
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
