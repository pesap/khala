import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverConfiguredModelNames } from "../dist/src/khala-setup.js";

function fakePi(body) {
	const root = mkdtempSync(join(tmpdir(), "khala-setup-model-"));
	const piPath = join(root, "fake-pi");
	writeFileSync(piPath, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
	chmodSync(piPath, 0o755);
	return { root, piPath };
}

test("model-list discovery parses normal output from a fake Pi", () => {
	const { root, piPath } = fakePi(`
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider conclave 100K 10K yes yes\\nprovider executor 100K 10K yes yes\\n");
} else {
  process.exit(1);
}
`);
	try {
		const discovery = discoverConfiguredModelNames([piPath]);
		assert.equal(discovery.reason, undefined);
		assert.deepEqual(discovery.models, ["provider/conclave", "provider/executor"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("model-list discovery rejects oversized output without parsing it", () => {
	const { root, piPath } = fakePi(`
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider conclave 100K 10K yes yes\\n".repeat(20000));
} else {
  process.exit(1);
}
`);
	try {
		const discovery = discoverConfiguredModelNames([piPath], { maxBufferBytes: 1024 });
		assert.equal(discovery.reason, "Pi model discovery output exceeded the size limit");
		assert.deepEqual(discovery.models, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("model-list discovery times out a hung fake Pi without parsing partial output", () => {
	const { root, piPath } = fakePi(`
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.stdout.write("provider conclave 100K 10K yes yes\\n");
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`);
	try {
		const discovery = discoverConfiguredModelNames([piPath], { timeoutMs: 200 });
		assert.equal(discovery.reason, "Pi model discovery timed out");
		assert.deepEqual(discovery.models, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("model-list discovery times out even when the fake Pi ignores SIGTERM", () => {
	const { root, piPath } = fakePi(`
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  process.on("SIGTERM", () => {});
  process.stdout.write("provider conclave 100K 10K yes yes\\n");
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`);
	try {
		const started = Date.now();
		const discovery = discoverConfiguredModelNames([piPath], { timeoutMs: 200 });
		assert.equal(discovery.reason, "Pi model discovery timed out");
		assert.deepEqual(discovery.models, []);
		assert.ok(Date.now() - started < 2_000, "discovery must not hang past the timeout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
