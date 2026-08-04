import { existsSync } from "node:fs";
import { join } from "node:path";

function resolveExtensionPath(directory: string): string {
	const compiledPath = join(directory, "index.js");
	if (existsSync(compiledPath)) {
		return compiledPath;
	}
	const sourcePath = join(directory, "index.ts");
	if (existsSync(sourcePath)) {
		return sourcePath;
	}
	throw new Error(`Khala extension could not be resolved from package directory: ${directory}.`);
}

function resolvePackageRoot(directory: string): string {
	if (existsSync(join(directory, "../../system-prompts"))) {
		return join(directory, "../..");
	}
	return join(directory, "..");
}

export { resolveExtensionPath, resolvePackageRoot };
