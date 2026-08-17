import { existsSync } from "node:fs";
import { createFileConclaveStorage } from "../../dist/src/khala-conclave-storage-file.js";
import { withArchiveLock } from "../../dist/src/khala-archive.js";

const [mode, projectPath, value] = process.argv.slice(2);
const waitState = new Int32Array(new SharedArrayBuffer(4));

if (mode === "hold") {
	withArchiveLock(projectPath, false, () => {
		process.send?.({ type: "locked" });
		while (!existsSync(value)) {
			Atomics.wait(waitState, 0, 0, 10);
		}
	});
	process.exit(0);
}

if (mode === "load") {
	process.send?.({ type: "ready" });
	process.once("message", () => {
		try {
			const sessionPath = createFileConclaveStorage().loadConclaveSession(projectPath, value).getSessionFile();
			process.send?.({ type: "loaded", sessionPath });
			process.exit(0);
		} catch (error) {
			process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) });
			process.exit(1);
		}
	});
}
