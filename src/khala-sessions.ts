// biome-ignore-all lint/style/noExcessiveLinesPerFile: The session projection intentionally keeps all role and review state in one roster pass.
// biome-ignore-all lint/style/noTernary: Optional monitor fields keep the existing row projection shape stable.
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { relative } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionContext, FileEntry } from "@earendil-works/pi-coding-agent";
import { getArchivePath } from "./khala-archive.js";
import { createArchiveSnapshot, type projectMissions } from "./khala-archive-projections.js";
import {
	ConfigScope,
	getKhalaConfigPath,
	LauncherName,
	type LauncherNameValue,
	loadKhalaConfig,
} from "./khala-config.js";
import { type ExecutorRecord, ExecutorStatus } from "./khala-model.js";
import {
	CONCLAVE_MONITOR_ENTRY_TYPES,
	type KhalaExecutionMonitor,
	projectExecutionMonitor,
} from "./khala-supervision-projection.js";

const KhalaSessionState = {
	input: "input",
	review: "review",
	stalled: "stalled",
	failed: "failed",
	working: "working",
} as const;
type KhalaSessionStateValue = (typeof KhalaSessionState)[keyof typeof KhalaSessionState];

interface KhalaSession {
	id: string;
	name: string;
	role: string;
	state: KhalaSessionStateValue;
	stateLabel: string;
	action: string;
	displayOnly: boolean;
	age: string;
	task: string;
	identity: string;
	session: string;
	skills: readonly string[];
	sessionPath: string;
	sessionPathLabel: string;
	isCurrent: boolean;
	launcher?: LauncherNameValue;
	target?: string;
	sandboxPath?: string;
	sandboxPathLabel?: string;
	latestSignal?: { kind: string; summary: string; observedAt: string };
	executionMonitor?: KhalaExecutionMonitor;
}

interface KhalaSessionSource {
	getActiveSessions: (currentPath: string) => KhalaSession[];
}
type ConclaveSessionPathReader = (projectPath: string, projectTrusted?: boolean) => string | undefined;

interface ConclaveMonitorEntryReader {
	read: (path: string | undefined) => readonly FileEntry[];
	needsRetry: () => boolean;
	clearRetry: () => void;
}

function createSessionSource(
	context: ExtensionContext,
	readConclavePath: ConclaveSessionPathReader,
	readUserPath: ConclaveSessionPathReader,
): KhalaSessionSource {
	let cached: Readonly<{ fingerprint: string; sessions: KhalaSession[] }> | undefined;
	const readConclaveMonitorEntries = createConclaveMonitorEntryReader();
	return {
		getActiveSessions: (currentPath) => {
			const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
			const conclavePath = readConclavePath(context.cwd, projectTrusted);
			const mappedUserPath = readUserPath(context.cwd, projectTrusted);
			const userPath = mappedUserPath ?? context.sessionManager.getSessionFile() ?? "";
			const fingerprint = createSessionListFingerprint({
				context,
				currentPath,
				projectTrusted,
				conclavePath,
				userPath,
			});
			if (cached?.fingerprint === fingerprint && !readConclaveMonitorEntries.needsRetry()) {
				return cached.sessions;
			}
			const sessions = buildSessionList(
				context,
				currentPath,
				() => conclavePath,
				() => mappedUserPath,
				readConclaveMonitorEntries,
			);
			cached = { fingerprint, sessions };
			return sessions;
		},
	};
}

function createSessionListFingerprint(
	input: Readonly<{
		context: ExtensionContext;
		currentPath: string;
		projectTrusted: boolean;
		conclavePath: string | undefined;
		userPath: string;
	}>,
): string {
	const projectConfigPath = input.projectTrusted ? getKhalaConfigPath(ConfigScope.project, input.context.cwd) : "";
	const archivePath = getArchivePath(input.context.cwd, input.projectTrusted);
	return [
		input.currentPath,
		input.projectTrusted ? "trusted" : "global",
		getSessionIdleState(input.context) ? "idle" : "working",
		fileFingerprint(getKhalaConfigPath(ConfigScope.global)),
		fileFingerprint(projectConfigPath),
		fileFingerprint(archivePath),
		fileFingerprint(input.conclavePath ?? ""),
		fileFingerprint(input.userPath),
	].join("\u0000");
}

type FileVersion = Readonly<{ path: string; size: number; mtimeMs: number; ino: number }>;
type CachedConclaveMonitorEntries = Readonly<
	FileVersion & { entries: readonly FileEntry[]; incompleteLineStart?: number }
>;
type ReadConclaveEntriesResult = Readonly<{ entries: FileEntry[]; success: boolean; incompleteLineStart?: number }>;

function fileFingerprint(path: string): string {
	const version = getFileVersion(path);
	if (version === undefined) {
		return `${path}:unavailable`;
	}
	return `${version.path}:${version.size}:${version.mtimeMs}:${version.ino}`;
}

function getFileVersion(path: string): FileVersion | undefined {
	if (path.length === 0) {
		return;
	}
	try {
		const stats = statSync(path);
		return { path, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
	} catch {
		// Missing or unreadable monitor files are represented by an unavailable version.
		// biome-ignore lint/complexity/noUselessUndefined: The explicit return satisfies the file-version reader contract.
		return undefined;
	}
}

function createConclaveMonitorEntryReader(): ConclaveMonitorEntryReader {
	let cached: CachedConclaveMonitorEntries | undefined;
	let retry = false;
	return {
		read: (path) => {
			const version = getFileVersion(path ?? "");
			if (version === undefined) {
				retry = false;
				return [];
			}
			const next = refreshConclaveMonitorEntries(cached, version);
			if (next === undefined) {
				retry = true;
				return cached?.entries ?? [];
			}
			cached = next;
			retry = false;
			return cached.entries;
		},
		needsRetry: () => retry,
		clearRetry: () => {
			retry = false;
		},
	};
}

function refreshConclaveMonitorEntries(
	cached: CachedConclaveMonitorEntries | undefined,
	version: FileVersion,
): CachedConclaveMonitorEntries | undefined {
	// Pi persists session entries append-only. An inode change indicates an atomic
	// replacement, which must discard the prior compact monitor projection.
	if (cached !== undefined && cached.path === version.path && cached.ino === version.ino) {
		if (cached.size === version.size && cached.mtimeMs === version.mtimeMs) {
			return cached;
		}
		if (cached.size < version.size) {
			return appendConclaveMonitorEntries(cached, version);
		}
	}
	return readFullConclaveMonitorEntries(version);
}

function appendConclaveMonitorEntries(
	cached: CachedConclaveMonitorEntries,
	version: FileVersion,
): CachedConclaveMonitorEntries | undefined {
	const update = readConclaveEntries(version.path, cached.incompleteLineStart ?? cached.size, version.size);
	if (!update.success) {
		return;
	}
	return {
		...version,
		entries: [...cached.entries, ...update.entries],
		...(update.incompleteLineStart === undefined ? {} : { incompleteLineStart: update.incompleteLineStart }),
	};
}

function readFullConclaveMonitorEntries(version: FileVersion): CachedConclaveMonitorEntries | undefined {
	const result = readConclaveEntries(version.path, 0, version.size);
	if (!result.success) {
		return;
	}
	return {
		...version,
		entries: result.entries,
		...(result.incompleteLineStart === undefined ? {} : { incompleteLineStart: result.incompleteLineStart }),
	};
}

function getSessionIdleState(context: ExtensionContext): boolean {
	return typeof context.isIdle === "function" && context.isIdle();
}

function isCurrentSession(path: string, currentPath: string): boolean {
	return path.length > 0 && path === currentPath;
}

function formatSessionPath(path: string, cwd: string): string {
	if (path.length === 0) {
		return "unavailable";
	}
	const relativePath = relative(cwd, path);
	if (relativePath.length === 0) {
		return ".";
	}
	return relativePath;
}

function getExecutorSessionState(status: string, signalKind: string | undefined): KhalaSessionStateValue {
	if (status === "failed") {
		return KhalaSessionState.failed;
	}
	if (signalKind === "blocked") {
		return KhalaSessionState.stalled;
	}
	if (status === "finished" || signalKind === "finished") {
		return KhalaSessionState.review;
	}
	return KhalaSessionState.working;
}

type ObserverView = Readonly<{ launcher: LauncherNameValue; target: string }>;

function getObserverView(executor: Pick<ExecutorRecord, "kind" | "launcher" | "target">): ObserverView | undefined {
	if (executor.kind !== "observer") {
		return;
	}
	if (executor.target === undefined || executor.target.length === 0) {
		return;
	}
	if (
		executor.launcher !== LauncherName.zellij &&
		executor.launcher !== LauncherName.tmux &&
		executor.launcher !== LauncherName.herdr
	) {
		return;
	}
	return { launcher: executor.launcher, target: executor.target };
}

function getObserverAction(view: ObserverView | undefined): string {
	if (view !== undefined) {
		return "view pane";
	}
	return "display only";
}

function getSessionStateLabel(state: KhalaSessionStateValue): string {
	if (state === KhalaSessionState.input) {
		return "Input Required";
	}
	if (state === KhalaSessionState.review) {
		return "Review Ready";
	}
	if (state === KhalaSessionState.stalled) {
		return "Possibly Stalled";
	}
	if (state === KhalaSessionState.failed) {
		return "Failed";
	}
	return "Active";
}

// biome-ignore lint/style/noMagicNumbers: 64 KiB bounds per-line scanning allocations.
const SESSION_LINE_SCAN_BUFFER_SIZE = 64 * 1024;
const LINE_FEED_BYTE = 10;

type PersistedSessionMessage = Readonly<{ role: string; stopReason?: string }>;
type PersistedSessionEntry = Readonly<{ type?: unknown; message?: unknown }>;
type PersistedSessionMessageData = Readonly<{ role?: unknown; stopReason?: unknown }>;

function getPersistedSessionState(path: string, role: string): KhalaSessionStateValue {
	if (path.length === 0 || !existsSync(path)) {
		return KhalaSessionState.working;
	}
	try {
		const latestMessage = readLatestSessionMessage(path);
		if (latestMessage === undefined) {
			return KhalaSessionState.input;
		}
		return getMessageSessionState(latestMessage, role);
	} catch {
		return KhalaSessionState.stalled;
	}
}

interface ReverseSessionLineScan {
	buffer?: Buffer;
	start: number;
	end: number;
}

function readLatestSessionMessage(path: string): PersistedSessionMessage | undefined {
	const descriptor = openSync(path, "r");
	try {
		let lineEnd = statSync(path).size;
		const scan: ReverseSessionLineScan = { start: 0, end: 0 };
		while (lineEnd > 0) {
			if (readSessionByte(descriptor, lineEnd - 1, scan) === LINE_FEED_BYTE) {
				lineEnd -= 1;
			} else {
				const lineStart = findPreviousLineBreak(descriptor, lineEnd, scan) + 1;
				const lineLength = lineEnd - lineStart;
				const line = Buffer.allocUnsafe(lineLength);
				if (readSync(descriptor, line, 0, line.length, lineStart) !== line.length) {
					throw new Error(`Unable to read persisted session: ${path}`);
				}
				const message = parsePersistedSessionMessage(line.toString("utf8"));
				if (message !== undefined) {
					return message;
				}
				lineEnd = lineStart - 1;
			}
		}
		// biome-ignore lint/complexity/noUselessUndefined: The explicit return satisfies the persisted-session reader contract.
		return undefined;
	} finally {
		closeSync(descriptor);
	}
}

function readSessionByte(descriptor: number, position: number, scan: ReverseSessionLineScan): number {
	if (scan.buffer !== undefined && position >= scan.start && position < scan.end) {
		return scan.buffer[position - scan.start] as number;
	}
	const byte = Buffer.allocUnsafe(1);
	if (readSync(descriptor, byte, 0, byte.length, position) !== 1) {
		throw new Error("Unable to scan persisted session.");
	}
	return byte[0] as number;
}

function findPreviousLineBreak(descriptor: number, lineEnd: number, scan?: ReverseSessionLineScan): number {
	let position = lineEnd;
	while (position > 0) {
		let buffer: Buffer;
		let bufferStart: number;
		let length: number;
		if (scan?.buffer !== undefined && scan.start < position && position <= scan.end) {
			const { buffer: cachedBuffer, start } = scan;
			buffer = cachedBuffer;
			bufferStart = start;
			length = position - bufferStart;
		} else {
			length = Math.min(SESSION_LINE_SCAN_BUFFER_SIZE, position);
			bufferStart = position - length;
			buffer = Buffer.allocUnsafe(length);
			if (readSync(descriptor, buffer, 0, length, bufferStart) !== length) {
				throw new Error("Unable to scan persisted session.");
			}
			if (scan !== undefined) {
				scan.buffer = buffer;
				scan.start = bufferStart;
				scan.end = position;
			}
		}
		for (let index = length - 1; index >= 0; index -= 1) {
			if (buffer[index] === LINE_FEED_BYTE) {
				return bufferStart + index;
			}
		}
		position = bufferStart;
	}
	return -1;
}

function parsePersistedSessionMessage(line: string): PersistedSessionMessage | undefined {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		// Pi skips malformed JSONL lines while loading a session, so the monitor does too.
		return;
	}
	if (!isPersistedSessionEntry(entry) || entry.type !== "message") {
		return;
	}
	const { message } = entry;
	if (!isPersistedSessionMessageData(message) || typeof message.role !== "string") {
		return;
	}
	if (typeof message.stopReason === "string") {
		return { role: message.role, stopReason: message.stopReason };
	}
	return { role: message.role };
}

function isPersistedSessionEntry(value: unknown): value is PersistedSessionEntry {
	return typeof value === "object" && value !== null;
}

function isPersistedSessionMessageData(value: unknown): value is PersistedSessionMessageData {
	return typeof value === "object" && value !== null;
}

function getMessageSessionState(message: PersistedSessionMessage, role: string): KhalaSessionStateValue {
	if (message.role !== "assistant") {
		if (message.role === "user" || message.role === "toolResult") {
			return KhalaSessionState.working;
		}
		return KhalaSessionState.input;
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return KhalaSessionState.stalled;
	}
	if (message.stopReason === "toolUse") {
		return KhalaSessionState.working;
	}
	if (role === "Conclave") {
		return KhalaSessionState.review;
	}
	return KhalaSessionState.input;
}

function getUserSessionState(context: ExtensionContext, path: string, currentPath: string): KhalaSessionStateValue {
	if (path.length > 0 && path === currentPath) {
		if (context.isIdle()) {
			return KhalaSessionState.input;
		}
		return KhalaSessionState.working;
	}
	return getPersistedSessionState(path, "User");
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The session projection is intentionally assembled in one read-only pass.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The projection keeps user, Conclave, Executor, and Observer state in one read-only pass.
// biome-ignore lint/complexity/useMaxParams: The projection receives independent storage readers at its read-model boundary.
function buildSessionList(
	context: ExtensionContext,
	currentPath: string,
	readConclavePath: ConclaveSessionPathReader,
	readUserPath: ConclaveSessionPathReader,
	readConclaveMonitorEntries: ConclaveMonitorEntryReader,
): KhalaSession[] {
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const conclavePath = readConclavePath(context.cwd, projectTrusted);
	const mappedUserPath = readUserPath(context.cwd, projectTrusted);
	let userPath = mappedUserPath ?? context.sessionManager.getSessionFile() ?? "";
	if (mappedUserPath === undefined && userPath === conclavePath) {
		userPath = "";
	}
	let userSessionLabel = "unavailable";
	if (userPath.length > 0) {
		userSessionLabel = userPath;
	}
	const userState = getUserSessionState(context, userPath, currentPath);
	const sessions: KhalaSession[] = [
		{
			id: "user",
			name: "You",
			role: "User",
			state: userState,
			stateLabel: getSessionStateLabel(userState),
			action: "context switch",
			displayOnly: false,
			age: "now",
			task: "current project",
			identity: "user",
			session: userSessionLabel,
			skills: [],
			sessionPath: userPath,
			sessionPathLabel: formatSessionPath(userPath, context.cwd),
			isCurrent: isCurrentSession(userPath, currentPath),
		},
	];
	const archive = createArchiveSnapshot(context.cwd, projectTrusted);
	const latestConclaveWake = archive.latestUnresolvedConclaveWake();

	if ((conclavePath !== undefined && existsSync(conclavePath)) || latestConclaveWake?.status === "failed") {
		let conclaveState = getPersistedSessionState(conclavePath ?? "", "Conclave");
		let conclaveTask = "Work governance";
		if (latestConclaveWake?.status === "failed") {
			conclaveState = KhalaSessionState.failed;
			conclaveTask = latestConclaveWake.failure ?? "Conclave wake failed";
		}
		let conclaveAction = "context switch";
		let conclaveDisplayOnly = false;
		if (latestConclaveWake?.status === "failed") {
			conclaveAction = "run /khala-recreate";
			if (latestConclaveWake.recovery === "setup") {
				conclaveAction = "run setup";
			}
			conclaveDisplayOnly = true;
		}
		sessions.push({
			id: "conclave",
			name: "Conclave",
			role: "Conclave",
			state: conclaveState,
			stateLabel: getSessionStateLabel(conclaveState),
			action: conclaveAction,
			displayOnly: conclaveDisplayOnly,
			age: "now",
			task: conclaveTask,
			identity: "conclave",
			session: conclavePath ?? "unavailable",
			skills: ["work-management", "verdict-issuing"],
			sessionPath: conclavePath ?? "",
			sessionPathLabel: formatSessionPath(conclavePath ?? "", context.cwd),
			isCurrent: conclavePath !== undefined && currentPath === conclavePath,
		});
	}

	let missions = [] as ReturnType<typeof projectMissions>[number]["mission"][];
	try {
		missions = archive.missions().map((projection) => projection.mission);
	} catch {
		// The existing session list remains usable while an incomplete lifecycle projection is repaired.
	}
	const config = readMonitorConfig(context.cwd, projectTrusted);
	const latestPullRequests = new Map<string, ReturnType<typeof archive.listPullRequests>[number]>();
	for (const pullRequest of archive.listPullRequests()) {
		latestPullRequests.set(pullRequest.executionId, pullRequest);
	}
	const reviewableExecutions = new Set(
		[...latestPullRequests.values()]
			.filter(
				(record) =>
					record.status === "reviewable" ||
					record.status === "draft" ||
					record.status === "open" ||
					record.status === "changes-requested",
			)
			.map((record) => record.executionId),
	);
	const workTitles = new Map<string, string>();
	for (const submission of archive.listSubmissions()) {
		workTitles.set(submission.workId, submission.work.title);
	}
	const latestSignals = new Map<string, ReturnType<typeof archive.listSignals>[number]>();
	for (const signal of archive.listSignals()) {
		const current = latestSignals.get(signal.executionId);
		if (current === undefined || signal.observedAt > current.observedAt) {
			latestSignals.set(signal.executionId, signal);
		}
	}
	const latestExecutions = new Map<string, ExecutorRecord>();
	const latestExecutionsByWork = new Map<string, ExecutorRecord>();
	for (const execution of archive.listExecutions()) {
		latestExecutions.set(execution.executionId, execution);
		const current = latestExecutionsByWork.get(execution.workId);
		if (current === undefined || execution.startedAt >= current.startedAt) {
			latestExecutionsByWork.set(execution.workId, execution);
		}
	}
	const activeExecutions = [...latestExecutions.values()].filter(
		(candidate) =>
			candidate.status === ExecutorStatus.starting ||
			candidate.status === ExecutorStatus.running ||
			(candidate.status === ExecutorStatus.failed &&
				latestExecutionsByWork.get(candidate.workId)?.executionId === candidate.executionId) ||
			(candidate.status === ExecutorStatus.finished && reviewableExecutions.has(candidate.executionId)),
	);
	// Conclave transcripts can be much larger than the Archive. Their supervision
	// entries are needed only for an Executor detail row, not an idle roster.
	const needsConclaveMonitorEntries = activeExecutions.some((execution) => execution.kind !== "observer");
	if (!needsConclaveMonitorEntries) {
		readConclaveMonitorEntries.clearRetry();
	}
	const conclaveEntries = needsConclaveMonitorEntries ? readConclaveMonitorEntries.read(conclavePath) : [];
	for (const executor of activeExecutions) {
		const latestSignal = latestSignals.get(executor.executionId);
		const state = getExecutorSessionState(executor.status, latestSignal?.kind);
		const isObserver = executor.kind === "observer";
		let idPrefix = "executor";
		let role = "Executor";
		let task = workTitles.get(executor.workId) ?? `Work ${executor.workId}`;
		let skills: readonly string[] = ["signals"];
		if (isObserver) {
			idPrefix = "observer";
			role = "Observer";
			task = `Context for Work ${executor.workId}`;
			skills = ["repository-observation", "learning"];
		}
		const view = getObserverView(executor);
		let executionMonitor: KhalaExecutionMonitor | undefined;
		if (!isObserver) {
			executionMonitor = projectExecutionMonitor({
				execution: executor,
				workTitle: task,
				missions,
				signals: archive.listSignals(),
				archiveRecords: archive.listRecords(),
				conclaveEntries,
				config,
			});
		}
		let sessionPathLabel = "separate Pi process";
		if (executor.sessionPath !== undefined) {
			sessionPathLabel = formatSessionPath(executor.sessionPath, context.cwd);
		}
		sessions.push({
			id: `${idPrefix}:${executor.executionId}`,
			name: executor.executorName,
			role,
			state,
			stateLabel: getSessionStateLabel(state),
			action: getObserverAction(view),
			displayOnly: true,
			age: latestSignal?.observedAt ?? executor.startedAt,
			task,
			identity: executor.executionId,
			session: executor.sessionPath ?? "separate Pi process",
			skills,
			sessionPath: "",
			sessionPathLabel,
			isCurrent: false,
			sandboxPath: executor.sandboxPath,
			sandboxPathLabel: formatSessionPath(executor.sandboxPath, context.cwd),
			...(view === undefined ? {} : { launcher: view.launcher, target: view.target }),
			...(latestSignal === undefined
				? {}
				: {
						latestSignal: {
							kind: latestSignal.kind,
							summary: latestSignal.summary,
							observedAt: latestSignal.observedAt,
						},
					}),
			...(executionMonitor === undefined ? {} : { executionMonitor }),
		});
	}

	return sessions;
}

// biome-ignore lint/style/noMagicNumbers: Match Pi's 1 MiB session stream buffer while retaining only monitor entries.
const CONCLAVE_SESSION_READ_BUFFER_SIZE = 1024 * 1024;

type PersistedConclaveEntry = Readonly<{ type?: unknown; customType?: unknown }>;

function readConclaveEntries(path: string, startPosition: number, endPosition: number): ReadConclaveEntriesResult {
	if (!existsSync(path)) {
		return { entries: [], success: false };
	}
	try {
		const descriptor = openSync(path, "r");
		try {
			const decoder = new StringDecoder("utf8");
			const buffer = Buffer.allocUnsafe(CONCLAVE_SESSION_READ_BUFFER_SIZE);
			const entries: FileEntry[] = [];
			let position = startPosition;
			let pending = "";
			while (position < endPosition) {
				const remaining = endPosition - position;
				const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), position);
				if (bytesRead === 0) {
					break;
				}
				position += bytesRead;
				pending += decoder.write(buffer.subarray(0, bytesRead));
				let lineStart = 0;
				let lineEnd = pending.indexOf("\n", lineStart);
				while (lineEnd >= 0) {
					const entry = parseConclaveMonitorEntry(pending.slice(lineStart, lineEnd));
					if (entry !== undefined) {
						entries.push(entry);
					}
					lineStart = lineEnd + 1;
					lineEnd = pending.indexOf("\n", lineStart);
				}
				pending = pending.slice(lineStart);
			}
			pending += decoder.end();
			const entry = parseConclaveMonitorEntry(pending);
			if (entry !== undefined) {
				entries.push(entry);
				return { entries, success: true };
			}
			if (pending.trim().length === 0) {
				return { entries, success: true };
			}
			return { entries, success: true, incompleteLineStart: findPreviousLineBreak(descriptor, endPosition) + 1 };
		} finally {
			closeSync(descriptor);
		}
	} catch {
		return { entries: [], success: false };
	}
}

function parseConclaveMonitorEntry(line: string): FileEntry | undefined {
	if (line.trim().length === 0) {
		return;
	}
	try {
		const entry: unknown = JSON.parse(line);
		if (isConclaveMonitorEntry(entry)) {
			return entry;
		}
	} catch {
		// Pi skips malformed JSONL lines while loading persisted sessions.
	}
	// biome-ignore lint/complexity/noUselessUndefined: The explicit return satisfies the session-line parser contract.
	return undefined;
}

function isConclaveMonitorEntry(value: unknown): value is FileEntry {
	if (!isPersistedConclaveEntry(value)) {
		return false;
	}
	return (
		(value.type === "custom" || value.type === "custom_message") &&
		typeof value.customType === "string" &&
		CONCLAVE_MONITOR_ENTRY_TYPES.has(value.customType)
	);
}

function isPersistedConclaveEntry(value: unknown): value is PersistedConclaveEntry {
	return typeof value === "object" && value !== null;
}

function readMonitorConfig(
	projectPath: string,
	projectTrusted: boolean,
): Readonly<{
	conclaveModel: string;
	executorModel: string;
	conclaveMaxCostUsdPerTurn: number;
	executorMaxCostUsdPerTurn: number;
}> {
	try {
		const config = loadKhalaConfig(projectPath, projectTrusted, false);
		return {
			conclaveModel: config.conclaveModel,
			executorModel: config.executorModel,
			conclaveMaxCostUsdPerTurn: config.conclaveMaxCostUsdPerTurn,
			executorMaxCostUsdPerTurn: config.executorMaxCostUsdPerTurn,
		};
	} catch {
		return {
			conclaveModel: "",
			executorModel: "",
			conclaveMaxCostUsdPerTurn: 0,
			executorMaxCostUsdPerTurn: 0,
		};
	}
}

export type { KhalaExecutionMonitor } from "./khala-supervision-projection.js";
export type { KhalaSession, KhalaSessionSource, KhalaSessionStateValue };
export { createSessionSource, KhalaSessionState };
