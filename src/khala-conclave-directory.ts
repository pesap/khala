import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { loadKhalaConfig } from "./khala-config.js";

function getConclaveDirectory(projectPath: string, projectTrusted = false): string {
	const projectKey = createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 24);
	return join(resolve(loadKhalaConfig(projectPath, projectTrusted, false).archiveRoot), projectKey);
}

export { getConclaveDirectory };
