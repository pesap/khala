// biome-ignore-all lint/style/noExcessiveLinesPerFile: The session projection intentionally keeps all role and review state in one roster pass.
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import type { ExtensionContext, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { createArchiveSnapshot } from "./khala-archive-projections.js";
import { LauncherName, type LauncherNameValue } from "./khala-config.js";
import { type ExecutorRecord, ExecutorStatus } from "./khala-model.js";

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
}

interface KhalaSessionSource {
	getActiveSessions: (currentPath: string) => KhalaSession[];
}
type ConclaveSessionPathReader = (projectPath: string, projectTrusted?: boolean) => string | undefined;

function createSessionSource(
	context: ExtensionContext,
	readConclavePath: ConclaveSessionPathReader,
	readUserPath: ConclaveSessionPathReader,
): KhalaSessionSource {
	return {
		getActiveSessions: (currentPath) => buildSessionList(context, currentPath, readConclavePath, readUserPath),
	};
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

type ExecutorView = Readonly<{ launcher: LauncherNameValue; target: string }>;

function getExecutorView(executor: Pick<ExecutorRecord, "launcher" | "target">): ExecutorView | undefined {
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

function getExecutorAction(view: ExecutorView | undefined): string {
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

function getPersistedSessionState(path: string, role: string): KhalaSessionStateValue {
	if (path.length === 0 || !existsSync(path)) {
		return KhalaSessionState.working;
	}
	try {
		const entries = parseSessionEntries(readFileSync(path, "utf8"));
		const latestMessage = [...entries]
			.reverse()
			.find((entry): entry is SessionMessageEntry => entry.type === "message");
		if (latestMessage === undefined) {
			return KhalaSessionState.input;
		}
		return getMessageSessionState(latestMessage, role);
	} catch {
		return KhalaSessionState.stalled;
	}
}

function getMessageSessionState(entry: SessionMessageEntry, role: string): KhalaSessionStateValue {
	const { message } = entry;
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
function buildSessionList(
	context: ExtensionContext,
	currentPath: string,
	readConclavePath: ConclaveSessionPathReader,
	readUserPath: ConclaveSessionPathReader,
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

	if (conclavePath !== undefined && existsSync(conclavePath)) {
		const conclaveState = getPersistedSessionState(conclavePath, "Conclave");
		sessions.push({
			id: "conclave",
			name: "Conclave",
			role: "Conclave",
			state: conclaveState,
			stateLabel: getSessionStateLabel(conclaveState),
			action: "context switch",
			displayOnly: false,
			age: "now",
			task: "Work governance",
			identity: "conclave",
			session: conclavePath,
			skills: ["work-management", "verdict-issuing"],
			sessionPath: conclavePath,
			sessionPathLabel: formatSessionPath(conclavePath, context.cwd),
			isCurrent: currentPath === conclavePath,
		});
	}

	const archive = createArchiveSnapshot(context.cwd, projectTrusted);
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
	for (const executor of [...latestExecutions.values()].filter(
		(candidate) =>
			candidate.status === ExecutorStatus.starting ||
			candidate.status === ExecutorStatus.running ||
			(candidate.status === ExecutorStatus.failed &&
				latestExecutionsByWork.get(candidate.workId)?.executionId === candidate.executionId) ||
			(candidate.status === ExecutorStatus.finished && reviewableExecutions.has(candidate.executionId)),
	)) {
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
		const view = getExecutorView(executor);
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
			action: getExecutorAction(view),
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
			// biome-ignore lint/style/noTernary: Compact optional projection keeps the row shape stable.
			...(view === undefined ? {} : { launcher: view.launcher, target: view.target }),
			// biome-ignore lint/style/noTernary: Compact optional projection keeps the row shape stable.
			...(latestSignal === undefined
				? {}
				: {
						latestSignal: {
							kind: latestSignal.kind,
							summary: latestSignal.summary,
							observedAt: latestSignal.observedAt,
						},
					}),
		});
	}

	return sessions;
}

export type { KhalaSession, KhalaSessionSource, KhalaSessionStateValue };
export { createSessionSource, KhalaSessionState };
