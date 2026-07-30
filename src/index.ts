// biome-ignore-all lint/style/noExcessiveLinesPerFile: Extension registration keeps role and lifecycle wiring together.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Extension hooks compose role, lifecycle, and durable delivery fences.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listLatestVerdictDeliveryRecords } from "./khala-archive-projections.js";
import { registerKhalaArchiveRead } from "./khala-archive-tool.js";
import { createConclaveCoordinator } from "./khala-conclave.js";
import { registerKhalaCounsel } from "./khala-counsel.js";
import { registerKhalaDemo } from "./khala-demo.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import {
	createConfiguredExecutorStarter,
	createConfiguredObserverStarter,
	createExecutorCloser,
	createExecutorViewer,
	finalizeConfiguredExecutorReview,
} from "./khala-executor.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import { KHALA_TOGGLE_SHORTCUT } from "./khala-keybindings.js";
import { registerKhalaLearning } from "./khala-learning.js";
import { ExecutorStatus } from "./khala-model.js";
import { registerKhalaObserver } from "./khala-observer.js";
import { resolveExtensionPath, resolvePackageRoot } from "./khala-package.js";
import { toggleKhalaPopup } from "./khala-popup.js";
import { registerKhalaReview } from "./khala-review.js";
import { KhalaRole, readRolePrompt, readSessionRole } from "./khala-role.js";
import type { KhalaSession } from "./khala-sessions.js";
import { createSessionSource } from "./khala-sessions.js";
import { registerKhalaSignal } from "./khala-signal.js";
import { setKhalaStatus } from "./khala-status.js";
import { registerKhalaTriage } from "./khala-triage.js";
import { readLatestVerdict, registerKhalaVerdict } from "./khala-verdict.js";
import { registerKhalaWork } from "./khala-work.js";

const baseDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolvePackageRoot(baseDir);
const conclaveCoordinator = createConclaveCoordinator(resolveExtensionPath(baseDir));

function isTrustedProject(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function isDedicatedConclaveSession(context: ExtensionContext): boolean {
	return context.sessionManager
		.getBranch()
		.some((entry) => entry.type === "custom" && entry.customType === KhalaEntryType.conclave);
}

function createExecutorViewHandler(
	context: ExtensionContext,
	viewExecutor: ReturnType<typeof createExecutorViewer> | undefined,
): ((session: KhalaSession) => Promise<void>) | undefined {
	if (viewExecutor === undefined) {
		return;
	}
	return async (session) => {
		if (session.launcher === undefined || session.target === undefined) {
			return;
		}
		try {
			await viewExecutor(session.launcher, session.target);
		} catch {
			updateExecutorRecord(context.cwd, session.identity, { status: ExecutorStatus.failed }, isTrustedProject(context));
			context.ui.notify(`The ${session.name} Executor pane is no longer available.`, "warning");
		}
	};
}

function registerPopupControls(pi: ExtensionAPI): (context: ExtensionContext) => Promise<void> {
	const showPopup = (context: ExtensionContext, onSwitch?: (path: string) => Promise<unknown>): Promise<void> => {
		let userSessionPath: string | undefined;
		if (!isDedicatedConclaveSession(context)) {
			userSessionPath = context.sessionManager.getSessionFile();
		}
		conclaveCoordinator.ensureConclaveSession(context.cwd, userSessionPath, isTrustedProject(context));
		let viewExecutor: ReturnType<typeof createExecutorViewer> | undefined;
		if (context.mode === "tui") {
			viewExecutor = createExecutorViewer();
		}
		return toggleKhalaPopup(
			context,
			createSessionSource(
				context,
				conclaveCoordinator.getConclaveSessionPath,
				conclaveCoordinator.getConclaveUserSessionPath,
			),
			onSwitch,
			createExecutorViewHandler(context, viewExecutor),
		);
	};
	pi.registerCommand("khala", {
		description: "Show the Khala active-session control surface.",
		handler: (_args, context) => showPopup(context, (path) => context.switchSession(path)),
	});
	pi.registerShortcut(KHALA_TOGGLE_SHORTCUT, {
		description: "Toggle the Khala active-session popup.",
		handler: (context) => showPopup(context),
	});
	return showPopup;
}

function registerConclaveRecovery(pi: ExtensionAPI): void {
	pi.registerCommand("khala-recreate", {
		description: "Recover the project Conclave and resume pending Work.",
		handler: (args, context) => {
			if (args.trim().length > 0) {
				context.ui.notify("Usage: /khala-recreate", "warning");
				return Promise.resolve();
			}
			let userSessionPath: string | undefined;
			if (!isDedicatedConclaveSession(context)) {
				userSessionPath = context.sessionManager.getSessionFile();
			}
			const sessionPath = conclaveCoordinator.ensureConclaveSession(
				context.cwd,
				userSessionPath,
				isTrustedProject(context),
			);
			conclaveCoordinator.resume(context.cwd, isTrustedProject(context));
			if (sessionPath === undefined) {
				context.ui.notify("Khala could not create the project Conclave.", "error");
			} else {
				context.ui.notify("Project Conclave is ready; pending Work was resumed.", "info");
			}
			return Promise.resolve();
		},
	});
}

function createExtension(pi: ExtensionAPI): void {
	registerKhalaFlags(pi);
	registerKhalaTools(pi);
	const showKhalaPopup = registerPopupControls(pi);
	registerKhalaSessionEvents(pi, showKhalaPopup);
}

function registerKhalaFlags(pi: ExtensionAPI): void {
	pi.registerFlag("khala-work-id", { description: "Internal Khala Work ID", type: "string" });
	pi.registerFlag("khala-execution-id", { description: "Internal Khala Executor execution ID", type: "string" });
	pi.registerFlag("khala-project-path", { description: "Internal Khala project path", type: "string" });
	pi.registerFlag("khala-project-trusted", { description: "Internal Khala project trust marker", type: "string" });
	pi.registerFlag("khala-agent-kind", { description: "Internal Khala agent kind", type: "string" });
	pi.registerFlag("khala-mission-id", { description: "Internal Khala Mission ID", type: "string" });
	pi.registerFlag("khala-mandate-id", { description: "Internal Khala Mandate ID", type: "string" });
	pi.registerFlag("khala-participant-id", { description: "Internal Khala participant ID", type: "string" });
	pi.registerFlag("khala-system-prompt-provided", {
		description: "Internal Khala marker that the role prompt was passed through --system-prompt",
		type: "boolean",
	});
}

function registerKhalaTools(pi: ExtensionAPI): void {
	registerKhalaSignal(
		pi,
		async (projectPath, signal, projectTrusted) => conclaveCoordinator.wakeSignal(projectPath, signal, projectTrusted),
		async (projectPath, signal, projectTrusted) => {
			const execution = readExecutorRecord(projectPath, signal.executionId, projectTrusted);
			if (execution !== undefined) {
				await finalizeConfiguredExecutorReview({
					execution,
					workId: signal.workId,
					projectTrusted: projectTrusted ?? false,
					summary: signal.summary,
					evidence: signal.evidence,
				});
			}
		},
	);
	registerKhalaLearning(
		pi,
		(projectPath, learning, projectTrusted) => conclaveCoordinator.wakeLearning(projectPath, learning, projectTrusted),
		createExecutorCloser(),
	);
	registerKhalaObserver(pi, {
		createObserverStarter: createConfiguredObserverStarter,
		observerSystemPrompt: readRolePrompt(packageRoot, "observer"),
		getSubmission: conclaveCoordinator.getSubmission,
		getPendingSubmission: conclaveCoordinator.getPendingSubmission,
		markSubmissionReviewing: conclaveCoordinator.markSubmissionReviewing,
		markSubmissionQueued: conclaveCoordinator.markSubmissionQueued,
		isDedicatedConclaveSession,
	});
	registerKhalaArchiveRead(pi, readSessionRole);
	registerKhalaCounsel(pi, (context) => readSessionRole(context) === KhalaRole.preserver);
	registerKhalaVerdict(
		pi,
		isDedicatedConclaveSession,
		conclaveCoordinator.requeueSubmission,
		conclaveCoordinator.deliverVerdict,
	);
	registerKhalaReview(pi, isDedicatedConclaveSession, (projectPath, workId, projectTrusted) =>
		conclaveCoordinator.wakeReview(projectPath, workId, projectTrusted),
	);
	registerConclaveRecovery(pi);
}

function registerKhalaSessionEvents(
	pi: ExtensionAPI,
	showKhalaPopup: (context: ExtensionContext) => Promise<void>,
): void {
	pi.on("session_start", (_event, context) => {
		setKhalaStatus(context, readSessionRole(context));
		registerLaunchedAgent(pi, context);
		if (!isDedicatedConclaveSession(context)) {
			conclaveCoordinator.resume(context.cwd, isTrustedProject(context));
		}
	});
	registerConfiguredKhalaWork(pi);
	registerKhalaTriage(pi);
	registerKhalaDemo(pi, {
		ensureConclaveSession: conclaveCoordinator.ensureConclaveSession,
		submitWork: conclaveCoordinator.submit,
		openMonitor: showKhalaPopup,
	});
	pi.on("before_agent_start", (event, context) => {
		const role = readSessionRole(context);
		if (role === null) {
			return;
		}
		const rolePrompt = readRolePrompt(packageRoot, role);
		const systemPromptProvided = pi.getFlag("khala-system-prompt-provided") === true;
		const { systemPrompt: eventSystemPrompt } = event;
		let systemPrompt = eventSystemPrompt;
		if (!systemPromptProvided) {
			systemPrompt = `${systemPrompt}\n\n${rolePrompt}`;
		}
		if (role === KhalaRole.executor) {
			const projectPath = pi.getFlag("khala-project-path");
			const executionId = pi.getFlag("khala-execution-id");
			if (typeof projectPath === "string" && typeof executionId === "string") {
				const trustedFlag = pi.getFlag("khala-project-trusted");
				let projectTrusted = isTrustedProject(context);
				if (typeof trustedFlag === "string") {
					projectTrusted = trustedFlag === "true";
				} else if (typeof trustedFlag === "boolean") {
					projectTrusted = trustedFlag;
				}
				const verdict = readLatestVerdict(projectPath, executionId, projectTrusted);
				if (verdict !== undefined) {
					systemPrompt += `\n\nA durable Conclave Verdict is recorded for this execution: ${verdict.decision}. Reason: ${verdict.reason}`;
				}
				const pendingDeliveries = listLatestVerdictDeliveryRecords(projectPath, projectTrusted).filter(
					(delivery) => delivery.executionId === executionId && delivery.status !== "delivered",
				);
				for (const delivery of pendingDeliveries) {
					systemPrompt += `\n\nPending durable Verdict delivery: ${delivery.message}`;
				}
			}
		}
		return { systemPrompt };
	});
}

function registerLaunchedAgent(pi: ExtensionAPI, context: ExtensionContext): void {
	const workId = pi.getFlag("khala-work-id");
	const executionId = pi.getFlag("khala-execution-id");
	const projectPath = pi.getFlag("khala-project-path");
	if (typeof workId !== "string" || typeof executionId !== "string" || typeof projectPath !== "string") {
		return;
	}
	let agentKind = "executor";
	let defaultName = "Executor";
	const isObserver = pi.getFlag("khala-agent-kind") === "observer";
	if (isObserver) {
		agentKind = "observer";
		defaultName = "Observer";
	}
	const executorName = context.sessionManager.getSessionName() ?? defaultName;
	const hasMarker = context.sessionManager.getBranch().some((entry) => {
		if (entry.type !== "custom") {
			return false;
		}
		if (isObserver) {
			return entry.customType === KhalaEntryType.observer;
		}
		return entry.customType === KhalaEntryType.executor;
	});
	const trustedFlag = pi.getFlag("khala-project-trusted");
	let projectTrusted = isTrustedProject(context);
	if (typeof trustedFlag === "string") {
		projectTrusted = trustedFlag === "true";
	} else if (typeof trustedFlag === "boolean") {
		projectTrusted = trustedFlag;
	}
	if (!hasMarker) {
		const missionId = pi.getFlag("khala-mission-id");
		const mandateId = pi.getFlag("khala-mandate-id");
		const participantId = pi.getFlag("khala-participant-id");
		let marker: {
			workId: string;
			executionId: string;
			executorName: string;
			projectPath: string;
			projectTrusted: boolean;
			kind: string;
			missionId?: string;
			mandateId?: string;
			participantId?: string;
		} = { workId, executionId, executorName, projectPath, projectTrusted, kind: agentKind };
		if (typeof missionId === "string") {
			marker = { ...marker, missionId };
		}
		if (typeof mandateId === "string") {
			marker = { ...marker, mandateId };
		}
		if (typeof participantId === "string") {
			marker = { ...marker, participantId };
		}
		if (isObserver) {
			pi.appendEntry(KhalaEntryType.observer, marker);
		} else {
			pi.appendEntry(KhalaEntryType.executor, marker);
		}
	}
	const sessionPath = context.sessionManager.getSessionFile();
	if (sessionPath !== undefined) {
		updateExecutorRecord(projectPath, executionId, { sessionPath }, projectTrusted);
	}
}

function registerConfiguredKhalaWork(pi: ExtensionAPI): void {
	registerKhalaWork(pi, {
		workTemplate: readFileSync(join(packageRoot, "templates", "khala-work.md"), "utf8").trim(),
		executorSystemPrompt: readRolePrompt(packageRoot, "executor"),
		createExecutorStarter: createConfiguredExecutorStarter,
		isDedicatedConclaveSession,
		submitWork: conclaveCoordinator.submit,
		getSubmission: conclaveCoordinator.getSubmission,
		getPendingSubmission: conclaveCoordinator.getPendingSubmission,
		claimSubmission: conclaveCoordinator.claimSubmission,
		markSubmissionQueued: conclaveCoordinator.markSubmissionQueued,
		markSubmissionLaunched: conclaveCoordinator.markSubmissionLaunched,
	});
}

export { createExecutorViewHandler, createExtension as default };
