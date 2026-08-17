import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { getConclaveDirectory } from "./khala-conclave-directory.js";
import { KhalaEntryType } from "./khala-entry-types.js";

const CONCLAVE_MODEL_SESSION_MAX_BYTES = 16_777_216;
const CONCLAVE_MODEL_SESSION_MAX_IDLE_MS = 2_592_000_000;

function getConclaveSessionPath(projectPath: string, projectTrusted = false): string | undefined {
	const { sessionPath: mappedSessionPath } =
		readConclaveMapping(getProjectPaths(projectPath, projectTrusted).mappingPath) ?? {};
	let sessionPath: string | undefined;
	if (mappedSessionPath !== undefined && existsSync(mappedSessionPath)) {
		sessionPath = mappedSessionPath;
	}
	return sessionPath;
}

function getConclaveUserSessionPath(projectPath: string, projectTrusted = false): string | undefined {
	return readConclaveMapping(getProjectPaths(projectPath, projectTrusted).mappingPath)?.userSessionPath;
}

function loadConclaveSession(projectPath: string, userSessionPath?: string, projectTrusted = false): SessionManager {
	const paths = getProjectPaths(projectPath, projectTrusted);
	const mapping = readConclaveMapping(paths.mappingPath);
	let mappedUserSessionPath = mapping?.userSessionPath;
	if (userSessionPath !== undefined && userSessionPath !== mapping?.sessionPath) {
		mappedUserSessionPath = userSessionPath;
	}
	if (
		mapping?.sessionPath !== undefined &&
		existsSync(mapping.sessionPath) &&
		!shouldRotateConclaveModelSession(mapping.sessionPath)
	) {
		const sessionManager = SessionManager.open(mapping.sessionPath, paths.sessionDir, projectPath);
		if (isConclaveSession(sessionManager)) {
			if (mappedUserSessionPath !== mapping.userSessionPath) {
				writeConclaveMapping(paths.mappingPath, mapping.sessionPath, mappedUserSessionPath);
			}
			return sessionManager;
		}
	}

	const sessionManager = SessionManager.create(projectPath, paths.sessionDir);
	sessionManager.appendCustomEntry(KhalaEntryType.conclave, { projectPath });
	sessionManager.appendSessionInfo("Khala Conclave");
	const sessionPath = sessionManager.getSessionFile();
	if (sessionPath === undefined) {
		return sessionManager;
	}
	writeSessionAtomically(sessionPath, sessionManager);
	writeConclaveMapping(paths.mappingPath, sessionPath, mappedUserSessionPath);
	return SessionManager.open(sessionPath, paths.sessionDir, projectPath);
}

function shouldRotateConclaveModelSession(sessionPath: string): boolean {
	const stats = statSync(sessionPath);
	return (
		stats.size >= CONCLAVE_MODEL_SESSION_MAX_BYTES || Date.now() - stats.mtimeMs >= CONCLAVE_MODEL_SESSION_MAX_IDLE_MS
	);
}

function isConclaveSession(sessionManager: SessionManager): boolean {
	return sessionManager
		.getEntries()
		.some((entry) => entry.type === "custom" && entry.customType === KhalaEntryType.conclave);
}

function getProjectPaths(projectPath: string, projectTrusted = false): { mappingPath: string; sessionDir: string } {
	const conclaveDirectory = getConclaveDirectory(projectPath, projectTrusted);
	return { mappingPath: join(conclaveDirectory, "session.json"), sessionDir: join(conclaveDirectory, "sessions") };
}

type ConclaveMapping = Readonly<{ sessionPath: string; userSessionPath?: string }>;

function readConclaveMapping(mappingPath: string): ConclaveMapping | undefined {
	if (!existsSync(mappingPath)) {
		return;
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(mappingPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("sessionPath" in parsed)) {
			return;
		}
		const { sessionPath, userSessionPath } = parsed as { sessionPath?: unknown; userSessionPath?: unknown };
		if (typeof sessionPath !== "string" || sessionPath.length === 0) {
			return;
		}
		if (userSessionPath !== undefined && (typeof userSessionPath !== "string" || userSessionPath.length === 0)) {
			return;
		}
		if (typeof userSessionPath === "string") {
			return { sessionPath, userSessionPath };
		}
		return { sessionPath };
	} catch {
		// A malformed session mapping is treated as absent and can be recreated.
	}
	const noMapping: ConclaveMapping | undefined = undefined;
	return noMapping;
}

function writeConclaveMapping(mappingPath: string, sessionPath: string, userSessionPath?: string): void {
	const mapping: { sessionPath: string; userSessionPath?: string } = { sessionPath };
	if (userSessionPath !== undefined) {
		mapping.userSessionPath = userSessionPath;
	}
	writeJsonAtomically(mappingPath, mapping);
}

function writeSessionAtomically(path: string, sessionManager: SessionManager): void {
	const header = sessionManager.getHeader();
	if (header === null) {
		throw new Error("Cannot persist a Conclave session without a session header.");
	}
	const entries = [header, ...sessionManager.getEntries()];
	mkdirSync(join(path, ".."), { recursive: true });
	const temporaryPath = `${path}.${nanoid()}.tmp`;
	writeFileSync(temporaryPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
	renameSync(temporaryPath, path);
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const temporaryPath = `${path}.${nanoid()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

export {
	CONCLAVE_MODEL_SESSION_MAX_BYTES,
	CONCLAVE_MODEL_SESSION_MAX_IDLE_MS,
	getConclaveSessionPath,
	getConclaveUserSessionPath,
	loadConclaveSession,
};
