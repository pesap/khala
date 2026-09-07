import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { SQLiteArchive } from "../dist/src/archive.js";

function sidecarPath(path) {
	return `${path}.supervision.sqlite`;
}

async function makeArchive() {
	const directory = await mkdtemp(join(tmpdir(), "khala-supervision-"));
	const path = join(directory, "archive.sqlite");
	const archive = new SQLiteArchive(path);
	return { archive, directory, path };
}

async function waitForOutput(child, expected) {
	let output = "";
	for await (const chunk of child.stdout) {
		output += chunk;
		if (output.includes(expected)) return;
	}
	throw new Error(`Child exited before writing ${expected}: ${output}`);
}

test("independent Archive handles exclude supervision until release", async () => {
	const { archive, directory, path } = await makeArchive();
	const competing = new SQLiteArchive(path);
	try {
		assert.equal(archive.acquireSupervision(), true);
		assert.equal(competing.acquireSupervision(), false);
		archive.releaseSupervision();
		assert.equal(competing.acquireSupervision(), true);
		assert.equal((await lstat(sidecarPath(path))).mode & 0o777, 0o600);
	} finally {
		archive.close();
		competing.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("supervision initializes an empty sidecar left by interrupted creation", async () => {
	const { archive, directory, path } = await makeArchive();
	await writeFile(sidecarPath(path), "", { mode: 0o600 });
	try {
		assert.equal(archive.acquireSupervision(), true);
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("different Archives have independent supervision locks", async () => {
	const first = await makeArchive();
	const second = await makeArchive();
	try {
		assert.equal(first.archive.acquireSupervision(), true);
		assert.equal(second.archive.acquireSupervision(), true);
	} finally {
		first.archive.close();
		second.archive.close();
		await rm(first.directory, { recursive: true, force: true });
		await rm(second.directory, { recursive: true, force: true });
	}
});

test("a crashed supervision owner releases its native lock", async () => {
	const { archive, directory, path } = await makeArchive();
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { SQLiteArchive } from ${JSON.stringify(join(dirname(new URL(import.meta.url).pathname), "../dist/src/archive.js"))}; const archive = new SQLiteArchive(${JSON.stringify(path)}); if (!archive.acquireSupervision()) process.exit(2); console.log("locked"); setInterval(() => {}, 1000);`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	try {
		await waitForOutput(child, "locked");
		assert.equal(archive.acquireSupervision(), false);
		child.kill("SIGKILL");
		await new Promise((resolve) => child.once("exit", resolve));
		assert.equal(archive.acquireSupervision(), true);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("read-only Archives cannot acquire or create supervision sidecars", async () => {
	const { archive, directory, path } = await makeArchive();
	archive.close();
	const readonly = new SQLiteArchive(path, { readOnly: true });
	try {
		assert.equal(readonly.acquireSupervision(), false);
		await assert.rejects(lstat(sidecarPath(path)), { code: "ENOENT" });
	} finally {
		readonly.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("symlinked supervision sidecars are rejected without modifying the target", async () => {
	const { archive, directory, path } = await makeArchive();
	const target = join(directory, "target");
	const sidecar = sidecarPath(path);
	await writeFile(target, "untouched", { mode: 0o644 });
	await symlink(target, sidecar);
	try {
		assert.throws(() => archive.acquireSupervision(), /symlink|regular/i);
		assert.equal(await readFile(target, "utf8"), "untouched");
	} finally {
		archive.close();
		await rm(directory, { recursive: true, force: true });
	}
});

