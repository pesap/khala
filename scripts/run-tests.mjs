import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const testDirectory = fileURLToPath(new URL("../test/", import.meta.url));
const runNativeTests = process.platform === "linux";
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
	.filter((entry) => runNativeTests || !entry.name.startsWith("native-"))
	.map((entry) => fileURLToPath(new URL(`../test/${entry.name}`, import.meta.url)))
	.sort();

if (!runNativeTests) {
	process.stderr.write("Skipping native workflow tests because they require Linux bubblewrap.\n");
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], { stdio: "inherit" });
if (result.error !== undefined) {
	process.stderr.write(`Could not start the test runner: ${result.error.message}\n`);
	process.exitCode = 1;
} else if (result.status === null) {
	process.stderr.write(`The test runner terminated with signal ${result.signal ?? "unknown"}.\n`);
	process.exitCode = 1;
} else {
	process.exitCode = result.status;
}
