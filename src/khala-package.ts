import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveExtensionPath(directory: string): string {
	const compiledPath = join(directory, "index.js");
	if (existsSync(compiledPath)) {
		return compiledPath;
	}
	return join(directory, "index.ts");
}

function resolvePackageRoot(directory: string): string {
	if (existsSync(join(directory, "../../system-prompts"))) {
		return join(directory, "../..");
	}
	return join(directory, "..");
}

export { resolveExtensionPath, resolvePackageRoot };
