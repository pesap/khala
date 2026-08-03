// biome-ignore-all lint/style/noProcessEnv: The bootstrap passes the inherited environment to the child.
// biome-ignore-all lint/style/useNamingConvention: Match the bootstrap environment contract.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const [, , suppliedMarkerPath, command, ...args] = process.argv;
if (suppliedMarkerPath === undefined || command === undefined) {
	process.stderr.write("Khala Observer bootstrap requires a marker and command.\n");
	process.exit(2);
}
const markerPath = suppliedMarkerPath;

function writeMarker(value: string): void {
	try {
		writeFileSync(markerPath, value, "utf8");
	} catch {
		// The parent retains the actionable child error; a missing sandbox is cleaned up separately.
	}
}

const child = spawn(command, args, {
	cwd: process.cwd(),
	env: { ...process.env, KHALA_STARTUP_MARKER: markerPath },
	stdio: "inherit",
});
child.once("error", (error) => {
	writeMarker(`exit:spawn:${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	if (code !== 0 || signal !== null) {
		writeMarker(`exit:${code ?? "null"}:${signal ?? "none"}`);
	}
	process.exitCode = code ?? 1;
});
