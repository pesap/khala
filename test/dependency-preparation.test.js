import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../dist/src/adapters.js";
import { DEPENDENCY_POLICY, preparationReceiptPath, prepareDependencyArtifacts, readPreparationReceipt } from "../dist/src/dependency-artifacts.js";

const npm = process.env.npm_execpath ?? execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
const dependencyTest = process.platform === "linux" ? test : test.skip;

async function createNpmFixture(root) {
	const config = join(root, "npm-config");
	const cache = join(root, "npm-cache");
	await mkdir(config, { recursive: true });
	await mkdir(cache, { recursive: true });
	const userConfig = join(config, "user.npmrc");
	const globalConfig = join(config, "global.npmrc");
	await writeFile(userConfig, "");
	await writeFile(globalConfig, "");
	return { cache, userConfig, globalConfig };
}
function npmOptions(fixture, prefix, cache = fixture.cache) {
	return ["--cache", cache, "--userconfig", fixture.userConfig, "--globalconfig", fixture.globalConfig, "--prefix", prefix];
}

dependencyTest("prepares a cold local tarball for offline script-free validation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-preparation-"));
	const fixture = join(root, "fixture");
	const npmFixture = await createNpmFixture(root);
	try {
		await mkdir(fixture);
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "cold-fixture", version: "1.0.0", dependencies: { "cold-dependency": "file:fixture.tgz" } }));
		await writeFile(join(root, "fixture.tgz"), "not yet a tarball");
		await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "cold-dependency", version: "1.0.0", scripts: { install: "touch ../lifecycle-ran" } }));
		await writeFile(join(fixture, "index.js"), "module.exports = 'offline';\n");
		execFileSync(npm, ["pack", "--ignore-scripts", "--offline", "--pack-destination", root, ...npmOptions(npmFixture, fixture)], {
			cwd: fixture,
			stdio: "pipe",
		});
		await rm(join(root, "fixture.tgz"));
		await rename(join(root, "cold-dependency-1.0.0.tgz"), join(root, "fixture.tgz"));
		await execFileSync(npm, ["install", "--package-lock-only", "--ignore-scripts", "--offline", ...npmOptions(npmFixture, root)], {
			cwd: root,
			stdio: "pipe",
		});
		await rm(join(root, "node_modules"), { recursive: true, force: true });

		const workspace = new GitWorkspace(root, "test/");
		const receipt = await workspace.prepareSandbox({ path: root, baseCommit: "base", branch: "test" });
		assert.equal(receipt.schemaVersion, 1);
		assert.deepEqual(receipt.policy.registries, ["registry.npmjs.org"]);
		assert.ok(receipt.artifactDigests.length > 0);

		const previousHome = process.env.HOME;
		process.env.HOME = join(root, "user-home-that-must-not-be-read");
		t.after(async () => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		});
		const results = await workspace.runValidation({
			path: root,
			commands: ["node -e \"require('cold-dependency'); require('node:fs').writeFileSync('validated', process.env.HOME)\""],
		});
		assert.equal(results[0].passed, true, results[0].output);
		assert.equal(await readFile(join(root, "validated"), "utf8"), "/tmp/khala-home");
		assert.equal(await readFile(join(root, "lifecycle-ran"), "utf8").catch(() => undefined), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

dependencyTest("prepares a remote-shaped tarball with npm12 while isolating hostile ancestor config", async (t) => {
	const ancestor = await mkdtemp(join(tmpdir(), "khala-npm-hostile-"));
	const sandbox = join(ancestor, "sandbox");
	const packageDirectory = join(ancestor, "remote-package");
	const store = join(ancestor, ".khala-artifacts");
	const hostilePrefix = join(ancestor, "hostile-prefix");
	const hostileConfig = `prefix=${hostilePrefix}\n`;
	const npmFixture = await createNpmFixture(ancestor);
	const resolved = "https://registry.npmjs.org/remote-shaped/-/remote-shaped-1.0.0.tgz";
	try {
		await mkdir(sandbox);
		await mkdir(packageDirectory);
		await writeFile(join(ancestor, "package.json"), JSON.stringify({ name: "hostile-ancestor", version: "1.0.0" }));
		await writeFile(join(ancestor, ".npmrc"), hostileConfig);
		await writeFile(
			join(packageDirectory, "package.json"),
			JSON.stringify({ name: "remote-shaped", version: "1.0.0", main: "index.js", scripts: { install: "touch npm-install-ran" } }),
		);
		await writeFile(join(packageDirectory, "index.js"), "module.exports = 'remote';\n");
		const packedName = execFileSync(
			npm,
			["pack", "--ignore-scripts", "--offline", "--pack-destination", ancestor, ...npmOptions(npmFixture, packageDirectory)],
			{ cwd: packageDirectory, encoding: "utf8" },
		).trim();
		const tarball = await readFile(join(ancestor, packedName));
		const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
		await writeFile(join(sandbox, "package.json"), JSON.stringify({ name: "remote-consumer", version: "1.0.0", dependencies: { "remote-shaped": "1.0.0" } }));
		await writeFile(
			join(sandbox, "package-lock.json"),
			JSON.stringify({
				lockfileVersion: 3,
				packages: {
					"": { name: "remote-consumer", version: "1.0.0", dependencies: { "remote-shaped": "1.0.0" } },
					"node_modules/remote-shaped": { version: "1.0.0", resolved, integrity },
				},
			}),
		);
		let fetchedUrl;
		let fetchCount = 0;
		t.mock.method(globalThis, "fetch", async (url, options) => {
			fetchCount += 1;
			fetchedUrl = url;
			assert.equal(options.redirect, "manual");
			assert.ok(options.signal instanceof AbortSignal);
			return new Response(tarball);
		});

		const receipt = await prepareDependencyArtifacts({
			sandboxPath: sandbox,
			baseCommit: "base",
			store,
			npmExecutable: npm,
			environment: { PATH: process.env.PATH },
			signal: undefined,
		});

		const secondReceipt = await prepareDependencyArtifacts({
			sandboxPath: sandbox,
			baseCommit: "base",
			store,
			npmExecutable: npm,
			environment: { PATH: process.env.PATH },
			signal: undefined,
		});
		const downloadName = `${createHash("sha256").update(integrity).digest("hex")}.tgz`;
		assert.equal(fetchedUrl, resolved);
		assert.equal(fetchCount, 1);
		assert.deepEqual(secondReceipt.artifactDigests, receipt.artifactDigests);
		assert.deepEqual(await readdir(join(store, "downloads")), [downloadName]);
		assert.equal(await readFile(join(ancestor, ".npmrc"), "utf8"), hostileConfig);
		assert.equal(await readdir(hostilePrefix).catch(() => undefined), undefined);

		// Exercise the actual locked registry dependency, not a direct local tarball install.
		const results = await new GitWorkspace(ancestor, "test/").runValidation({
			path: sandbox,
			commands: ["node -e \"require('node:assert/strict').equal(require('remote-shaped'), 'remote')\""],
		});
		assert.equal(results[0].passed, true, results[0].output);
		assert.equal(await readFile(join(ancestor, ".npmrc"), "utf8"), hostileConfig);
		assert.equal(await readdir(hostilePrefix).catch(() => undefined), undefined);
		assert.equal(fetchCount, 1);
		assert.equal(await readFile(join(sandbox, "node_modules", "remote-shaped", "npm-install-ran"), "utf8").catch(() => undefined), undefined);
	} finally {
		await rm(ancestor, { recursive: true, force: true });
	}
});

dependencyTest("non-Node workspaces require no dependency artifacts and Node manifests require a lockfile", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-no-node-preparation-"));
	try {
		const workspace = new GitWorkspace(root, "test/");
		const sandbox = { path: root, baseCommit: "base", branch: "test" };
		assert.equal((await workspace.prepareSandbox(sandbox)).kind, "no-node");
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "unlocked" }));
		await assert.rejects(workspace.prepareSandbox(sandbox), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

dependencyTest("dependency metadata cannot follow a symbolic link", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-manifest-symlink-"));
	try {
		await writeFile(join(root, "manifest.json"), JSON.stringify({ name: "linked" }));
		await symlink(join(root, "manifest.json"), join(root, "package.json"));
		await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
		await assert.rejects(new GitWorkspace(root, "test/").prepareSandbox({ path: root, baseCommit: "base", branch: "test" }), /unsafe|symbolic/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

dependencyTest("rejects a local artifact whose parent symlink escapes the workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-symlink-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-dependency-outside-"));
	try {
		const artifact = join(outside, "artifact.tgz");
		await writeFile(artifact, "outside");
		await symlink(outside, join(root, "linked"));
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "symlink-fixture" }));
		await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/bad": { resolved: "file:linked/artifact.tgz", integrity: `sha512-${createHash("sha512").update("outside").digest("base64")}` } } }));
		await assert.rejects(new GitWorkspace(root, "test/").prepareSandbox({ path: root, baseCommit: "base", branch: "test" }), /escapes|symbolic|workspace/i);
	} finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

dependencyTest("rejects an oversized local artifact before npm cache preparation", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-size-"));
	try {
		const contents = Buffer.alloc(DEPENDENCY_POLICY.maxArtifactBytes + 1);
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "size-fixture" }));
		await writeFile(join(root, "artifact.tgz"), contents);
		await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/big": { resolved: "file:artifact.tgz", integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}` } } }));
		await assert.rejects(new GitWorkspace(root, "test/").prepareSandbox({ path: root, baseCommit: "base", branch: "test" }), /size limit/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

dependencyTest("fails closed for corrupt preparation receipts", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-receipt-"));
	try {
		const store = join(root, "store");
		const sandbox = join(root, "sandbox");
		const receiptPath = preparationReceiptPath(store, sandbox);
		await mkdir(join(store, "x"), { recursive: true });
		await mkdir(join(store, preparationReceiptPath(store, sandbox).split("/").at(-2)), { recursive: true });
		await writeFile(receiptPath, "not json");
		await assert.rejects(readPreparationReceipt(store, sandbox), /receipt.*JSON|invalid/i);
	} finally { await rm(root, { recursive: true, force: true }); }
});

dependencyTest("interrupted artifact streams fail without publishing partial cache entries", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-stream-"));
	try {
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "stream-fixture" }));
		await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: { "node_modules/stream": { resolved: "https://registry.npmjs.org/stream/-/stream-1.0.0.tgz", integrity: "sha512-AAAA" } } }));
		t.mock.method(globalThis, "fetch", async (_url, options) => {
			assert.equal(options.redirect, "manual");
			assert.ok(options.signal instanceof AbortSignal);
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.error(new Error("interrupted stream")); } }));
		});
		const store = join(root, "store");
		await assert.rejects(prepareDependencyArtifacts({ sandboxPath: root, baseCommit: "base", store, npmExecutable: npm, environment: { PATH: process.env.PATH }, signal: undefined }), /could not be acquired/);
		assert.deepEqual(await readdir(join(store, "downloads")), []);
		assert.equal(await readPreparationReceipt(store, root), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

for (const scenario of [
	{ name: "redirect", cached: false, fetches: 1, error: /not downloaded \(302\)/, response: () => new Response(null, { status: 302, headers: { location: "https://unapproved.invalid/package.tgz" } }) },
	{ name: "download-corruption", cached: false, fetches: 1, error: /Integrity verification failed/, response: () => new Response("corrupt downloaded bytes") },
	{ name: "cache-corruption", cached: true, fetches: 0, error: /Integrity verification failed/, response: () => { throw new Error("Cached corruption must not trigger a download"); } },
]) {
	dependencyTest(`dependency preparation rejects ${scenario.name} without publishing a receipt`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "khala-artifact-rejection-"));
		const store = join(root, "store");
		const integrity = `sha512-${createHash("sha512").update("authorized bytes").digest("base64")}`;
		const downloadName = `${createHash("sha256").update(integrity).digest("hex")}.tgz`;
		let fetchCount = 0;
		try {
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "rejection-fixture" }));
			await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {
				"node_modules/checked": { resolved: "https://registry.npmjs.org/checked/-/checked-1.0.0.tgz", integrity },
			} }));
			if (scenario.cached) {
				await mkdir(join(store, "downloads"), { recursive: true });
				await writeFile(join(store, "downloads", downloadName), "corrupt cached bytes");
			}
			t.mock.method(globalThis, "fetch", async (_url, options) => {
				fetchCount += 1;
				assert.equal(options.redirect, "manual");
				return scenario.response();
			});
			await assert.rejects(prepareDependencyArtifacts({
				sandboxPath: root, baseCommit: "base", store, npmExecutable: npm,
				environment: { PATH: process.env.PATH }, signal: undefined,
			}), scenario.error);
			assert.equal(fetchCount, scenario.fetches);
			assert.deepEqual(await readdir(join(store, "downloads")), scenario.cached ? [downloadName] : []);
			assert.equal(await readPreparationReceipt(store, root), undefined);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

dependencyTest("rejects a lockfile dependency outside the approved registry", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-dependency-policy-"));
	try {
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "policy-fixture", version: "1.0.0" }));
		await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/bad": { resolved: "http://evil.invalid/bad.tgz", integrity: "sha512-AAAA" } } }));
		const workspace = new GitWorkspace(root, "test/");
		await assert.rejects(workspace.prepareSandbox({ path: root, baseCommit: "base", branch: "test" }), /approved npm registry policy/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
