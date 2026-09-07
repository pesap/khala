import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitWorkspace } from "../dist/src/adapters.js";

async function listenPort() {
	const server = createServer((socket) => socket.destroy()).listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const port = server.address()?.port;
	if (port === undefined) throw new Error("Test server did not bind.");
	return { server, port };
}

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

test("validation only writes its workspace and has no host credentials or network", async () => {
	const root = await mkdtemp(join(tmpdir(), "khala-validation-"));
	const outside = await mkdtemp(join(tmpdir(), "khala-outside-"));
	const unrelated = join(outside, "unrelated-secret");
	const marker = join(outside, "descendant-leak");
	const { server, port } = await listenPort();
	await writeFile(join(root, "input.txt"), "ok");
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "isolation-fixture", version: "1.0.0" }));
	await writeFile(unrelated, "do not expose");
	const previousSecret = process.env.AWS_SECRET_ACCESS_KEY;
	process.env.AWS_SECRET_ACCESS_KEY = "test-secret-must-not-reach-validation";
	try {
		const workspace = new GitWorkspace(root, "test/");
		const hasBubblewrap = process.platform !== "win32" && await access("/usr/bin/bwrap").then(() => true).catch(() => false);
		const results = await workspace.runValidation({
			path: root,
			commands: [
				"printf ok > allowed.txt",
				`test ! -r ${unrelated}`,
				"test \"$HOME\" = /tmp/khala-home && test -z \"$AWS_SECRET_ACCESS_KEY\"",
				`node -e "require('node:http').get('http://127.0.0.1:${port}').on('response', () => process.exit(1)).on('error', e => process.exit(0))"`,
				`sh -c 'sleep 2; touch ${marker}' &`,
				"npm --version",
				`touch ${unrelated}`,
			],
		});
		if (!hasBubblewrap) {
			assert.equal(results.every(({ passed }) => !passed), true);
			assert.match(results[0].output, /isolation/i);
			return;
		}
		assert.equal(results[0].passed, true);
		assert.equal(results[1].passed, true, results[1].output);
		assert.equal(results[2].passed, true);
		assert.equal(results[3].passed, true, results[3].output);
		assert.equal(results[4].passed, true);
		assert.equal(results[5].passed, true, results[5].output);
		assert.equal(results[6].passed, false);
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
