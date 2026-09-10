import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../dist/src/adapters.js";
import { SQLiteArchive } from "../dist/src/archive.js";
import { makeService, meta, admitAndStart, restorePath } from "./helpers/mvp-fixtures.mjs";

test("a competing service cannot monitor or recover another supervisor's live Executor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-competing-supervisor-"));
	const path = join(directory, "archive.sqlite");
	const owner = makeService(path, { executorHold: true, runtimeState: "working" });
	const competitor = makeService(path, { runtimeState: "unreachable" });
	try {
		const running = await admitAndStart(owner.service, "exclusive-owner");
		const revision = owner.service.inspectWork(running.workId).revision;
		await competitor.service.runAutonomousCycle();
		assert.equal(competitor.service.inspectWork(running.workId).revision, revision);
		assert.equal(competitor.controls.sessions.length, 0);
		assert.equal(competitor.controls.stopped.length, 0);
		await assert.rejects(
			competitor.service.recoverWork(running.workId, meta("user", "foreign-recovery", revision)),
			/supervisor/i,
		);
		assert.equal(competitor.controls.stopped.length, 0);
		owner.controls.releaseExecutor();
		await owner.service.close();
		await competitor.service.processPendingEffects();
		assert.equal(competitor.archive.acquireSupervision(), true);
	} finally {
		owner.controls.releaseExecutor?.();
		await owner.service.close();
		await competitor.service.close();
	}
});

test("supervision remains exclusive until runtime shutdown finishes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-supervisor-shutdown-"));
	const path = join(directory, "archive.sqlite");
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	const owner = makeService(path, { ports: { runtime: { async close() { entered.resolve(); await release.promise; } } } });
	const competitor = new SQLiteArchive(path);
	try {
		await owner.service.processPendingEffects();
		const closing = owner.service.close();
		await entered.promise;
		assert.equal(competitor.acquireSupervision(), false);
		release.resolve();
		await closing;
		assert.equal(competitor.acquireSupervision(), true);
	} finally {
		release.resolve();
		await owner.service.close();
		competitor.close();
	}
});

test("a child service leaves runtime effects to the parent supervisor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-child-supervisor-"));
	const { service, controls } = makeService(join(directory, "archive.sqlite"), { supervision: "client" });
	try {
		service.submitWork({ title: "Client submission", objective: "No child launches", acceptanceCriteria: ["Parent owns effects"] }, meta("user", "client-submit", 0));
		await service.processPendingEffects();
		await service.runAutonomousCycle();
		assert.equal(controls.sessions.length, 0);
	} finally {
		await service.close();
	}
});

test("generated Work IDs use Nano ID format", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-work-id-"));
	const { service } = makeService(join(directory, "archive.sqlite"));
	const submitted = service.submitWork(
		{ title: "Generated ID", objective: "Verify generated IDs", acceptanceCriteria: ["The ID uses Nano ID format"] },
		meta("user", "work-id:submit", 0),
	);
	assert.match(submitted.workId, /^[A-Za-z0-9_-]{21}$/);
	assert.throws(
		() =>
			service.submitWork(
				{ title: "Different Work", objective: "Reuse the command", acceptanceCriteria: ["It is rejected"] },
				meta("user", "work-id:submit", 0),
			),
		/different input/,
	);
	assert.throws(
		() =>
			service.submitWork(
				{ title: "Path traversal", objective: "Reject path traversal", acceptanceCriteria: ["It is rejected"], allowedPaths: ["src/../secret"] },
				meta("user", "path-traversal:submit", 0),
			),
		/invalid path/,
	);
	assert.throws(
		() =>
			service.submitWork(
				{ title: "Git pathspec", objective: "Reject pathspec syntax", acceptanceCriteria: ["It is rejected"], allowedPaths: [":(glob)**"] },
				meta("user", "pathspec:submit", 0),
			),
		/invalid path/,
	);
	await service.close();
});

test("Sandbox creation rejects symlinked worktree parents", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-sandbox-symlink-"));
	const worktreeRoot = join(directory, "worktrees");
	const outside = join(directory, "outside");
	await mkdir(worktreeRoot);
	await mkdir(outside);
	const workId = "sandbox-symlink";
	const workKey = createHash("sha256").update(workId).digest("hex").slice(0, 24);
	await symlink(outside, join(worktreeRoot, workKey));
	const workspace = new GitWorkspace(worktreeRoot, "khala/");
	await assert.rejects(
		workspace.ensureSandbox({
			workId,
			executionId: "execution-1",
			mission: {
				missionId: "mission-1",
				workId,
				assignment: {
					title: "Sandbox",
					objective: "Reject symlinked parents",
					context: "",
					scope: "The sandbox",
					acceptanceCriteria: ["The parent is rejected"],
					constraints: [],
					validation: ["check"],
					allowedPaths: ["."],
					maxTokens: 100,
				},
				mandateRevision: 1,
				createdAt: new Date().toISOString(),
			},
			projectPath: directory,
			baseCommit: "base",
		}),
		/outside the worktree root/,
	);
});

test("Executors commit and validate through governed workspace actions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-governed-tools-"));
	let committed = false;
	let validated = false;
	let commitReceiverPreserved = false;
	let validationReceiverPreserved = false;
	const { service, controls } = makeService(join(directory, "archive.sqlite"), {
		ports: {
			workspace: {
				receiverMarker: "governed-workspace",
				async commitSandbox() {
					committed = true;
					commitReceiverPreserved = this.receiverMarker === "governed-workspace";
					return "head";
				},
				async runValidation(input) {
					validated = input.commands.length > 0;
					validationReceiverPreserved = this.receiverMarker === "governed-workspace";
					return input.commands.map((command) => ({ command, passed: true, output: "ok" }));
				},
			},
		},
	});
	const running = await admitAndStart(service, "governed-tools");
	const executorSession = controls.sessions.find((session) => session.binding.sessionId.startsWith("executor-"));
	assert.equal(executorSession?.input.tools.includes("bash"), false);
	const commit = await service.perform({
		action: "commit-sandbox",
		workId: running.workId,
		input: {},
		meta: meta("executor", "governed-tools:commit", running.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in commit, false);
	assert.equal(committed, true);
	assert.equal(commitReceiverPreserved, true);
	const validation = await service.perform({
		action: "run-validation",
		workId: running.workId,
		input: {},
		meta: meta("executor", "governed-tools:validate", commit.value.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in validation, false);
	assert.equal(validated, true);
	assert.equal(validationReceiverPreserved, true);
	const review = await service.perform({
		action: "create-review-request",
		workId: running.workId,
		input: {},
		meta: meta("executor", "governed-tools:review", validation.value.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in review, false);
	const ready = await service.perform({
		action: "record-signal",
		workId: running.workId,
		input: { kind: "ready", summary: "Ready", evidence: ["validation passed"] },
		meta: meta("executor", "governed-tools:ready", review.value.revision, running.workId, running.execution.executionId),
	});
	assert.equal("error" in ready, false);
	await service.close();
});

test("GitWorkspace commits with its receiver and returns the committed head", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-git-commit-"));
	const repository = join(directory, "repository");
	await mkdir(repository);
	execFileSync("git", ["init", repository]);
	execFileSync("git", ["-C", repository, "config", "user.email", "khala@example.test"]);
	execFileSync("git", ["-C", repository, "config", "user.name", "Khala Test"]);
	await writeFile(join(repository, "file.txt"), "before\n");
	execFileSync("git", ["-C", repository, "add", "."]);
	execFileSync("git", ["-C", repository, "commit", "-m", "initial"]);
	const baseCommit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	await writeFile(join(repository, "file.txt"), "after\n");
	const workspace = new GitWorkspace(directory, "khala/", repository);
	const committedHead = await workspace.commitSandbox({
		sandbox: { path: repository, baseCommit, branch: "main" },
		allowedPaths: ["."],
		message: "change",
	});
	const actualHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	assert.equal(committedHead, actualHead);
	assert.notEqual(committedHead, baseCommit);
});

test("GitWorkspace hydrates sandbox dependencies for commit and validation", async (t) => {
	if (process.platform !== "linux") return t.skip("Dependency hydration and isolated validation require Linux bubblewrap.");
	const directory = await mkdtemp(join(tmpdir(), "khala-commit-toolchain-"));
	const parent = join(directory, "parent");
	const remote = join(directory, "remote.git");
	const worktreeRoot = join(directory, "worktrees");
	const dependency = join(parent, "dependency");
	const inheritedBin = join(directory, "inherited", "NODE_MODULES", ".BIN");
	const inheritedBinAlias = join(directory, "inherited-bin");
	await mkdir(parent);
	execFileSync("git", ["init", "--bare", remote]);
	execFileSync("git", ["init", parent]);
	execFileSync("git", ["-C", parent, "config", "user.email", "khala@example.test"]);
	execFileSync("git", ["-C", parent, "config", "user.name", "Khala Test"]);
	execFileSync("git", ["-C", parent, "remote", "add", "origin", remote]);
	execFileSync("git", ["-C", parent, "config", "core.hooksPath", join(parent, ".git", "hooks")]);
	await mkdir(dependency);
	await writeFile(join(parent, "package.json"), '{"name":"parent","private":true,"type":"module","dependencies":{"parent-hook-dependency":"file:./dependency"}}\n');
	await writeFile(join(dependency, "package.json"), '{"name":"parent-hook-dependency","version":"1.0.0","type":"module","exports":"./index.js","bin":{"parent-hook-tool":"./bin.mjs","git":"./git.mjs"}}\n');
	await writeFile(join(dependency, "index.js"), "export const loaded = true;\n");
	await writeFile(join(dependency, "bin.mjs"), '#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nawait writeFile(`.parent-tool-${process.argv[2]}-ran`, process.argv[2]);\n');
	await writeFile(join(dependency, "git.mjs"), "#!/usr/bin/env node\nprocess.exit(97);\n");
	await writeFile(join(parent, "file.txt"), "before\n");
	await writeFile(join(parent, "hook-config.mjs"), 'import { loaded } from "parent-hook-dependency";\nif (!loaded) process.exit(1);\n');
	execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: parent });
	execFileSync("git", ["-C", parent, "add", "."]);
	execFileSync("git", ["-C", parent, "commit", "-m", "initial"]);
	const baseCommit = execFileSync("git", ["-C", parent, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	await mkdir(inheritedBin, { recursive: true });
	await writeFile(join(inheritedBin, "parent-hook-tool"), "#!/bin/sh\nexit 98\n");
	await writeFile(join(inheritedBin, "inherited-only-tool"), "#!/bin/sh\nexit 94\n");
	await writeFile(join(inheritedBin, "git"), "#!/bin/sh\nexit 96\n");
	await writeFile(join(inheritedBin, "npm"), "#!/bin/sh\nexit 95\n");
	await chmod(join(inheritedBin, "parent-hook-tool"), 0o755);
	await chmod(join(inheritedBin, "inherited-only-tool"), 0o755);
	await chmod(join(inheritedBin, "git"), 0o755);
	await chmod(join(inheritedBin, "npm"), 0o755);
	await symlink(inheritedBin, inheritedBinAlias, process.platform === "win32" ? "junction" : "dir");
	await Promise.all(
		["pre-commit", "pre-push"].map(async (hookName) => {
			const hook = join(parent, ".git", "hooks", hookName);
			await writeFile(hook, `#!/bin/sh\nset -eu\nif command -v inherited-only-tool >/dev/null; then exit 94; fi\nparent-hook-tool ${hookName}\nnode hook-config.mjs\ngit rev-parse --is-inside-work-tree > .${hookName}-git-ran\n`);
			await chmod(hook, 0o755);
		}),
	);
	const previousPath = process.env.PATH;
	const inheritedPath = [`"${inheritedBinAlias}"`, previousPath].filter(Boolean).join(delimiter);
	process.env.PATH = inheritedPath;
	try {
		const workspace = new GitWorkspace(worktreeRoot, "khala/", parent);
		const sandboxInput = {
			workId: "commit-toolchain",
			executionId: "execution-1",
			mission: {
				missionId: "mission-1",
				workId: "commit-toolchain",
				assignment: {
					title: "Commit toolchain",
					objective: "Run sandbox hooks",
					context: "",
					scope: "Commit the sandbox",
					acceptanceCriteria: ["The hook resolves its package"],
					constraints: [],
					validation: ["check"],
					allowedPaths: ["."],
					maxTokens: 100,
				},
				mandateRevision: 1,
				createdAt: new Date().toISOString(),
			},
			projectPath: parent,
			baseCommit,
		};
		const sandbox = await workspace.ensureSandbox(sandboxInput);
		assert.deepEqual(await workspace.ensureSandbox(sandboxInput), sandbox);
		const packageManifest = await readFile(join(sandbox.path, "package.json"), "utf8");
		const lockfile = await readFile(join(sandbox.path, "package-lock.json"), "utf8");
		await writeFile(join(sandbox.path, "file.txt"), "after\n");
		let committedHead = await workspace.commitSandbox({ sandbox, allowedPaths: ["."], message: "change" });
		assert.equal(await readFile(join(sandbox.path, ".parent-tool-pre-commit-ran"), "utf8"), "pre-commit");
		assert.equal(await readFile(join(sandbox.path, ".pre-commit-git-ran"), "utf8"), "true\n");
		await rm(join(sandbox.path, ".parent-tool-pre-commit-ran"));
		await rm(join(sandbox.path, ".pre-commit-git-ran"));
		await writeFile(join(sandbox.path, "file.txt"), "later\n");
		await writeFile(join(sandbox.path, "node_modules", "generated.js"), "generated\n");
		restorePath(previousPath);
		execFileSync("git", ["-C", sandbox.path, "add", "node_modules/generated.js"]);
		process.env.PATH = inheritedPath;
		committedHead = await workspace.commitSandbox({ sandbox, allowedPaths: ["."], message: "second change" });
		restorePath(previousPath);
		const committedPaths = execFileSync("git", ["-C", sandbox.path, "show", "--format=", "--name-only", committedHead], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
		assert.equal(committedPaths.some((path) => path.startsWith("node_modules/")), false);
		process.env.PATH = inheritedPath;
		await rm(join(sandbox.path, "node_modules"), { recursive: true });
		const validation = await workspace.runValidation({ path: sandbox.path, commands: ["parent-hook-tool validation", "node hook-config.mjs"] });
		assert.equal(validation.every((result) => result.passed), true);
		assert.equal((await stat(join(sandbox.path, "node_modules", "parent-hook-dependency"))).isDirectory(), true);
		assert.equal(await readFile(join(sandbox.path, ".parent-tool-validation-ran"), "utf8"), "validation");
		assert.equal(await readFile(join(sandbox.path, "package.json"), "utf8"), packageManifest);
		assert.equal(await readFile(join(sandbox.path, "package-lock.json"), "utf8"), lockfile);
		assert.equal(await workspace.publishSandbox(sandbox), committedHead);
		assert.equal(await readFile(join(sandbox.path, ".parent-tool-pre-push-ran"), "utf8"), "pre-push");
		assert.equal(await readFile(join(sandbox.path, ".pre-push-git-ran"), "utf8"), "true\n");
		await workspace.removeSandbox(sandbox);
		await assert.rejects(stat(sandbox.path));
		restorePath(previousPath);
		assert.equal(
			execFileSync("git", ["-C", remote, "rev-parse", `refs/heads/${sandbox.branch}`], { encoding: "utf8" }).trim(),
			committedHead,
		);
	} finally {
		restorePath(previousPath);
	}
});

test("Failed validation retains stdout and stderr diagnostics", async (t) => {
	if (process.platform !== "linux") return t.skip("Isolated validation requires Linux bubblewrap.");
	const directory = await mkdtemp(join(tmpdir(), "khala-validation-output-"));
	const fakeBin = join(directory, "bin");
	await mkdir(fakeBin);
	await writeFile(join(fakeBin, "npm"), "#!/bin/sh\nexit 95\n");
	await chmod(join(fakeBin, "npm"), 0o755);
	const previousPath = process.env.PATH;
	process.env.PATH = [fakeBin, previousPath].filter(Boolean).join(delimiter);
	try {
		const workspace = new GitWorkspace(directory, "khala/");
		const [result] = await workspace.runValidation({
			path: directory,
			commands: [
				"printf '%3000s' '' | tr ' ' s; printf 'stdout detail\\n'; printf '%3000s' '' | tr ' ' e >&2; printf 'stderr detail\\n' >&2; exit 1",
			],
		});
		assert.equal(result.passed, false);
		assert.match(result.output, /stdout detail/);
		assert.match(result.output, /stderr detail/);
	} finally {
		restorePath(previousPath);
	}
});
