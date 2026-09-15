import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import { test } from "node:test";
import { verifyNativePiVersion } from "../dist/src/runtime-launch.js";


test("native Pi version verification scrubs sensitive environment variables", async () => {
	const directory = await mkdtemp(join(tmpdir(), "khala-runtime-version-"));
	const script = join(directory, "version-check.mjs");
	const secretKey = "KHALA_VERSION_CHECK_SECRET";
	const previousSecret = process.env[secretKey];
	await writeFile(
		script,
		'if (process.argv.includes("--version")) process.stdout.write(process.env.PI_OFFLINE === "1" && process.env.KHALA_VERSION_CHECK_SECRET === undefined ? "0.85.0\\n" : "unexpected\\n");\n',
	);
	process.env[secretKey] = "must-not-leak";
	try {
		await verifyNativePiVersion([process.execPath, script], directory);
	} finally {
		if (previousSecret === undefined) delete process.env[secretKey];
		else process.env[secretKey] = previousSecret;
		await rm(directory, { recursive: true, force: true });
	}
});
