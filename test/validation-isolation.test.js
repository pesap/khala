import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../dist/src/adapters.js";

async function listenPort() {
	const server = createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const port = server.address()?.port;
	if (port === undefined) throw new Error("Test server did not bind.");
	return { server, port };
}

test("validation executes declared commands in its workspace on macOS", { skip: process.platform !== "darwin" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-macos-validation-"));
	try {
		const workspace = new GitWorkspace(root, "test/");
		const [result] = await workspace.runValidation({ path: root, commands: ["printf ok > marker && printf validated"] });
		assert.equal(result.passed, true, result.output);
		assert.equal(result.output, "validated");
		assert.equal(await readFile(join(root, "marker"), "utf8"), "ok");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("missing Linux isolation prerequisites fail closed with an actionable diagnostic", { skip: process.platform !== "linux" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "khala-no-bwrap-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	for (const command of ["sh", "git", "npm", "ps"]) {
		const path = execFileSync("/bin/sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
		await symlink(path, join(bin, command));
	}
	const previousPath = process.env.PATH;
	t.after(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	});
	process.env.PATH = bin;
	const workspace = new GitWorkspace(root, "test/");
	const [result] = await workspace.runValidation({ path: root, commands: ["touch marker"] });
	assert.equal(result.passed, false);
	assert.match(result.output, /Validation isolation prerequisites are unavailable/);
	await assert.rejects(
		workspace.prepareSandbox({ path: root, baseCommit: "base", branch: "test" }),
		/Validation isolation prerequisites are unavailable/,
	);
	await assert.rejects(access(join(root, "marker")), { code: "ENOENT" });
});

test("validation rejects outside paths and symlink escapes before executing commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-validation-root-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-validation-outside-"));
	try {
		await symlink(outside, join(root, "escape"));
		const workspace = new GitWorkspace(root, "test/");
		for (const path of [outside, join(root, "escape")]) {
			const [result] = await workspace.runValidation({ path, commands: ["touch marker"] });
			assert.equal(result.passed, false);
			assert.match(result.output, /outside the configured worktree root/);
		}
		await assert.rejects(access(join(outside, "marker")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("validation only writes its workspace and has no host credentials or network", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-validation-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-outside-"));
	const unrelated = join(outside, "unrelated-secret");
	const marker = join(outside, "descendant-leak");
	const { server, port } = await listenPort();
	await writeFile(join(root, "input.txt"), "ok");
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "isolation-fixture", version: "1.0.0" }));
	await writeFile(unrelated, "do not expose");
	await symlink(outside, join(root, "escape"));
	const previousSecret = process.env.AWS_SECRET_ACCESS_KEY;
	process.env.AWS_SECRET_ACCESS_KEY = "test-secret-must-not-reach-validation";
	try {
		const workspace = new GitWorkspace(root, "test/");
		const results = await workspace.runValidation({
			path: root,
			commands: [
				"printf ok > allowed.txt",
				`test ! -r ${unrelated}`,
				"test -z \"$AWS_SECRET_ACCESS_KEY\" && printf private > \"$HOME/marker\" && printf temporary > \"$TMPDIR/marker\" && printf '%s' \"$HOME\"",
				`node -e "require('node:http').get('http://127.0.0.1:${port}').on('response', () => process.exit(1)).on('error', e => process.exit(0))"`,
				`sh -c 'sleep 2; touch ${marker}' &`,
				"npm --version",
				`touch ${unrelated}`,
				"test ! -r escape/unrelated-secret && test ! -w escape/unrelated-secret",
				"touch escape/symlink-leak",
			],
		});
		assert.equal(results[0].passed, true);
		assert.equal(results[1].passed, true, results[1].output);
		assert.equal(results[2].passed, true, results[2].output);
		assert.notEqual(results[2].output, process.env.HOME);
		assert.match(results[2].output, /khala-validation-[^/]+\/home$/);
		assert.equal(results[3].passed, true, results[3].output);
		assert.equal(results[4].passed, true);
		assert.equal(results[5].passed, true, results[5].output);
		assert.equal(results[6].passed, false);
		assert.equal(results[7].passed, true, results[7].output);
		assert.equal(results[8].passed, false);
		await assert.rejects(access(join(outside, "symlink-leak")), { code: "ENOENT" });
		assert.equal(await readFile(unrelated, "utf8"), "do not expose");
		assert.equal(await readFile(join(root, "allowed.txt"), "utf8"), "ok");
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		await assert.rejects(readFile(marker));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
		server.close();
		if (previousSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
		else process.env.AWS_SECRET_ACCESS_KEY = previousSecret;
	}
});

test("validation cannot connect to a host Unix socket inside its workspace", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join("/tmp", "khala-socket-"));
	const workspacePath = join(await realpath(root), "workspace");
	const socketPath = join(workspacePath, "host.sock");
	let connections = 0;
	const server = createServer((socket) => { connections += 1; socket.destroy(); });
	try {
		await mkdir(workspacePath);
		server.listen(socketPath);
		await new Promise((resolve) => server.once("listening", resolve));
		const [result] = await new GitWorkspace(root, "test/").runValidation({
			path: workspacePath,
			commands: [`test -S '${socketPath}' || exit 10; node -e "require('node:net').connect('${socketPath}').on('connect', () => process.exit(1)).on('error', () => process.exit(0))"`],
		});
		assert.equal(result.passed, true, result.output);
		assert.equal(connections, 0, "Validation connected to the host socket.");
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	}
});

test("concurrent validations keep their workspace permissions separate", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-concurrent-validation-"));
	const first = join(root, "first");
	const second = join(root, "second");
	try {
		await mkdir(first);
		await mkdir(second);
		const workspace = new GitWorkspace(root, "test/");
		const results = await Promise.all([first, second].map((path) => workspace.runValidation({
			path,
			commands: [`printf private > secret && sleep 1 && test ! -r ../${path === first ? "second" : "first"}/secret`],
		})));
		for (const [result] of results) assert.equal(result.passed, true, result.output);
		assert.equal(await readFile(join(first, "secret"), "utf8"), "private");
		assert.equal(await readFile(join(second, "secret"), "utf8"), "private");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("workspace binaries cannot replace the isolation launcher", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-launcher-validation-"));
	const workspacePath = join(root, "workspace");
	const bin = join(workspacePath, "node_modules", ".bin");
	const marker = join(root, "launcher-leak");
	try {
		await mkdir(bin, { recursive: true });
		for (const name of ["bwrap", "sandbox-exec"]) {
			const path = join(bin, name);
			await writeFile(path, `#!/bin/sh\ntouch '${marker}'\nprintf replaced\n`);
			await chmod(path, 0o755);
		}
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["printf protected"] });
		assert.equal(result.passed, true, result.output);
		assert.equal(result.output, "protected");
		await assert.rejects(access(marker), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a symlinked inherited node_modules bin cannot expose workspace host helpers", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "khala-linked-bin-")));
	const workspacePath = join(root, "workspace");
	const tools = join(workspacePath, "tools");
	const modules = join(workspacePath, "node_modules");
	const bin = join(modules, ".bin");
	const marker = join(root, "helper-leak");
	const previousPath = process.env.PATH;
	try {
		await mkdir(tools, { recursive: true });
		await mkdir(modules);
		await symlink(tools, bin);
		await writeFile(join(tools, "which"), `#!/bin/sh\nprintf leak > '${marker}'\nexec /usr/bin/which "$@"\n`);
		await chmod(join(tools, "which"), 0o755);
		process.env.PATH = [bin, previousPath].filter(Boolean).join(":");
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["printf protected"] });
		await assert.rejects(access(marker), { code: "ENOENT" });
		assert.equal(result.passed, true, result.output);
		assert.equal(result.output, "protected");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("preparation rejects an empty resolver PATH before executing host helpers", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "khala-empty-path-")));
	const workspacePath = join(root, "workspace");
	const bin = join(workspacePath, "node_modules", ".bin");
	const marker = join(root, "helper-leak");
	const previousPath = process.env.PATH;
	try {
		await mkdir(bin, { recursive: true });
		await writeFile(join(workspacePath, "which"), `#!/bin/sh\nprintf leak > '${marker}'\nexec /usr/bin/which "$@"\n`);
		await chmod(join(workspacePath, "which"), 0o755);
		const workspace = new GitWorkspace(root, "test/");
		for (const path of [":", bin]) {
			process.env.PATH = path;
			const failure = await workspace.prepareSandbox({ path: workspacePath, baseCommit: "base", branch: "test" }).catch((error) => error);
			await assert.rejects(access(marker), { code: "ENOENT" });
			assert.ok(failure instanceof Error, "Preparation accepted an empty resolver PATH.");
			assert.match(failure.message, /Inherited PATH contains no trusted executable directories/);
		}
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("resolver normalization rejects delimiter-bearing filesystem paths before host helper execution", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "khala-delimited-path-")));
	const workspacePath = join(root, "workspace");
	const tools = join(root, "tools:");
	const alias = join(root, "alias");
	const servicePath = join(root, "service::");
	const marker = join(root, "helper-leak");
	const previousPath = process.env.PATH;
	const previousCwd = process.cwd();
	try {
		await Promise.all([mkdir(workspacePath), mkdir(tools), mkdir(servicePath)]);
		await symlink(tools, alias);
		await writeFile(join(workspacePath, "which"), `#!/bin/sh\nprintf leak > '${marker}'\nexec /usr/bin/which "$@"\n`);
		await chmod(join(workspacePath, "which"), 0o755);
		const workspace = new GitWorkspace(root, "test/");
		for (const entry of [alias, "missing-bin"]) {
			if (entry === "missing-bin") process.chdir(servicePath);
			process.env.PATH = [entry, previousPath].filter(Boolean).join(":");
			const failure = await workspace.prepareSandbox({ path: workspacePath, baseCommit: "base", branch: "test" }).catch((error) => error);
			await assert.rejects(access(marker), { code: "ENOENT" });
			assert.ok(failure instanceof Error, "Preparation accepted a delimiter-bearing resolver path.");
			assert.match(failure.message, /Inherited PATH directories must not contain PATH delimiters/);
		}
	} finally {
		process.chdir(previousCwd);
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("inherited executable lookup preserves symlink traversal for existing and missing PATH entries", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "khala-symlink-path-")));
	const host = join(root, "host");
	const toolchain = join(root, "toolchain");
	const previousPath = process.env.PATH;
	try {
		await mkdir(join(toolchain, "release"), { recursive: true });
		for (const [parent, head] of [[host, "wrong-head"], [toolchain, "selected-head"]]) {
			await mkdir(join(parent, "bin"), { recursive: true });
			await writeFile(join(parent, "bin", "git"), `#!/bin/sh\nprintf '${head}'\n`);
			await chmod(join(parent, "bin", "git"), 0o755);
		}
		await mkdir(join(root, "missing", "release"), { recursive: true });
		await assert.rejects(access(join(root, "missing", "bin")), { code: "ENOENT" });
		await symlink(join(toolchain, "release"), join(host, "current"));
		await symlink(join(root, "missing", "release"), join(host, "unavailable"));
		for (const entry of ["current", "unavailable"]) {
			process.env.PATH = [`${join(host, entry)}/../bin`, join(toolchain, "bin"), previousPath].filter(Boolean).join(":");
			assert.equal(await new GitWorkspace(root, "test/").inspectHead(root), "selected-head", entry);
		}
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("missing inherited PATH entries cannot replace host validation helpers", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "khala-relative-path-")));
	const workspacePath = join(root, "workspace");
	const relativeBin = basename(root);
	const bin = join(workspacePath, relativeBin);
	const marker = join(root, "launcher-leak");
	const previousPath = process.env.PATH;
	try {
		await assert.rejects(access(resolve(relativeBin)), { code: "ENOENT" });
		await mkdir(bin, { recursive: true });
		for (const name of ["which", "bwrap"]) {
			const script = name === "which" ? 'exec /usr/bin/which "$@"' : "printf replaced";
			await writeFile(join(bin, name), `#!/bin/sh\nprintf leak > '${marker}'\n${script}\n`);
			await chmod(join(bin, name), 0o755);
		}
		process.env.PATH = [relativeBin, previousPath].filter(Boolean).join(":");
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["printf protected"] });
		await assert.rejects(access(marker), { code: "ENOENT" });
		assert.equal(result.passed, true, result.output);
		assert.equal(result.output, "protected");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("macOS validation cannot run a workspace ps during ownership checks", { skip: process.platform !== "darwin" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-ps-validation-"));
	const workspacePath = join(root, "workspace");
	const bin = join(root, "repository", "node_modules", ".bin");
	const marker = join(root, "ownership-leak");
	const previousPath = process.env.PATH;
	try {
		await mkdir(workspacePath);
		await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "ps"), `#!/bin/sh\nprintf leak > '${marker}'\nexec /bin/ps "$@"\n`);
		await chmod(join(bin, "ps"), 0o755);
		process.env.PATH = [bin, previousPath].filter(Boolean).join(":");
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["printf protected"] });
		assert.equal(result.passed, true, result.output);
		assert.equal(result.output, "protected");
		await assert.rejects(access(marker), { code: "ENOENT" });
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("validation resolves npm and npx from the selected separate installation", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-separate-npm-"));
	const workspacePath = join(root, "workspace");
	const prefixBin = join(root, "npm-prefix", "bin");
	const npmRoot = join(root, "npm-prefix", "lib", "node_modules", "npm");
	const previousPath = process.env.PATH;
	try {
		await mkdir(workspacePath);
		await mkdir(prefixBin, { recursive: true });
		await mkdir(join(npmRoot, "bin"), { recursive: true });
		await writeFile(join(workspacePath, "package.json"), JSON.stringify({ name: "separate-npm-fixture" }));
		await writeFile(join(npmRoot, "package.json"), JSON.stringify({ name: "npm", version: "88.77.66" }));
		for (const name of ["npm", "npx"]) {
			const path = join(npmRoot, "bin", `${name}-cli.js`);
			await writeFile(path, "#!/usr/bin/env node\nconsole.log('88.77.66');\n");
			await chmod(path, 0o755);
			await symlink(path, join(prefixBin, name));
		}
		process.env.PATH = `${prefixBin}:${previousPath}`;
		const results = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["npm --version", "npx --version"] });
		for (const result of results) {
			assert.equal(result.passed, true, result.output);
			assert.equal(result.output.trim(), "88.77.66");
		}
		const workspaceBin = join(workspacePath, "node_modules", ".bin");
		await mkdir(workspaceBin, { recursive: true });
		await writeFile(join(workspaceBin, "npm"), "#!/usr/bin/env node\nconsole.log('workspace-npm');\n");
		await chmod(join(workspaceBin, "npm"), 0o755);
		const [local] = await new GitWorkspace(root, "test/").runValidation({ path: workspacePath, commands: ["npm --version"] });
		assert.equal(local.passed, true, local.output);
		assert.equal(local.output.trim(), "workspace-npm");
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(root, { recursive: true, force: true });
	}
});

test("failed validation retains command stdout and stderr", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-failed-validation-"));
	try {
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: root, commands: ["printf evidence; printf diagnostic >&2; exit 7"] });
		assert.equal(result.passed, false);
		assert.match(result.output, /stdout:\nevidence\nstderr:\ndiagnostic\nerror:\nValidation command failed \(7\)/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("timed-out validation retains command stdout and stderr", { skip: !["linux", "darwin"].includes(process.platform), timeout: 15_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "khala-timeout-validation-"));
	const fork = childProcess.fork;
	// Shorten only the external process deadline while exercising the real helper and sandbox.
	t.mock.method(childProcess, "fork", (path, args, options) => fork(path, args, { ...options, timeout: 3_000 }));
	syncBuiltinESMExports();
	try {
		const [result] = await new GitWorkspace(root, "test/").runValidation({
			path: root,
			commands: ["node -e \"process.stdout.write('before-timeout'); process.stderr.write('timeout-diagnostic'); setInterval(() => require('node:fs').appendFileSync('writes', 'x'), 25)\""],
		});
		assert.equal(result.passed, false);
		assert.match(result.output, /stdout:\nbefore-timeout/);
		assert.match(result.output, /stderr:\ntimeout-diagnostic/);
		assert.match(result.output, /SIGKILL/);
		const stopped = await readFile(join(root, "writes"), "utf8");
		assert.ok(stopped.length > 0);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(await readFile(join(root, "writes"), "utf8"), stopped);
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});

test("Linux validation contains deliberately detached descendants", { skip: process.platform !== "linux" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-detached-validation-"));
	try {
		await writeFile(join(root, "spawn.cjs"), "require('node:child_process').spawn(process.execPath, ['-e', \"setTimeout(() => require('node:fs').writeFileSync('detached-marker', 'leak'), 1500)\"], { detached: true, stdio: 'ignore' }).unref();\n");
		const [result] = await new GitWorkspace(root, "test/").runValidation({ path: root, commands: ["node spawn.cjs"] });
		assert.equal(result.passed, true, result.output);
		await new Promise((resolve) => setTimeout(resolve, 1_600));
		await assert.rejects(access(join(root, "detached-marker")), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("validation cancelled before launch does not execute its command", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-cancel-before-validation-"));
	try {
		await assert.rejects(
			new GitWorkspace(root, "test/").runValidation({ path: root, commands: ["touch marker"] }, { signal: AbortSignal.abort() }),
			/Validation was cancelled/,
		);
		await assert.rejects(access(join(root, "marker")), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelling validation stops writers in its process group", { skip: !["linux", "darwin"].includes(process.platform), timeout: 15_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-cancel-validation-"));
	const controller = new AbortController();
	try {
		const validation = new GitWorkspace(root, "test/").runValidation({
			path: root,
			commands: ["node -e \"setInterval(() => require('node:fs').appendFileSync('writes', 'x'), 25)\""],
		}, { signal: controller.signal });
		let writes;
		for (let attempt = 0; attempt < 100 && writes === undefined; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			writes = await readFile(join(root, "writes"), "utf8").catch(() => undefined);
		}
		assert.ok(writes?.length > 0, "Validation writer did not start.");
		controller.abort();
		await assert.rejects(validation, /Validation was cancelled/);
		const stopped = await readFile(join(root, "writes"), "utf8");
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(await readFile(join(root, "writes"), "utf8"), stopped);
	} finally {
		controller.abort();
		await rm(root, { recursive: true, force: true });
	}
});
