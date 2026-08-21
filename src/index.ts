// biome-ignore-all lint/style/noExcessiveLinesPerFile: Extension registration keeps role and lifecycle wiring together.
// biome-ignore-all lint/style/noProcessEnv: Observer startup readiness is passed through the child process environment.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Extension hooks compose role, lifecycle, and durable delivery fences.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Extension hooks compose role, lifecycle, and durable delivery fences.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { listLatestVerdictDeliveryRecords } from "./khala-archive-projections.js";
import { registerKhalaArchiveRead, registerRoleKhalaArchiveRead } from "./khala-archive-tool.js";
import { selectExecutorRecoveryModel, showKhalaAttention } from "./khala-attention-ui.js";
import {
	CONCLAVE_BASE_TOOL_ALLOWLIST,
	CONCLAVE_TOOL_ALLOWLIST,
	type ConclaveCoordinator,
	createConclaveCoordinator,
} from "./khala-conclave.js";
import { configureKhalaRuntimePaths, loadKhalaConfig } from "./khala-config.js";
import { registerKhalaCounsel } from "./khala-counsel.js";
import { registerKhalaDemo } from "./khala-demo.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import {
	createConfiguredExecutorStarter,
	createConfiguredObserverStarter,
	createObserverCloser,
	createObserverViewer,
	finalizeConfiguredExecutorReview,
} from "./khala-executor.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import { KHALA_TOGGLE_SHORTCUT } from "./khala-keybindings.js";
import { registerKhalaLearning } from "./khala-learning.js";
import { listPendingExecutorModelRecoveries, selectedUserExecutorModelRecovery } from "./khala-model-recovery.js";
import { registerKhalaObserver } from "./khala-observer.js";
import { registerKhalaOracle } from "./khala-oracle.js";
import { resolveExtensionPath, resolvePackageRoot } from "./khala-package.js";
import { registerKhalaReview } from "./khala-review.js";
import { KhalaRole, type KhalaRoleValue, readRolePrompt, readSessionRole } from "./khala-role.js";
import { registerKhalaSignal } from "./khala-signal.js";
import { setKhalaStatus } from "./khala-status.js";
import { getSupervisionController, hideAlignedAssessmentResponse, toolCallsFromMessage } from "./khala-supervision.js";
import { registerKhalaSupervisionTools } from "./khala-supervision-tools.js";
import { registerKhalaTriage } from "./khala-triage.js";
import { registerKhalaUserPriority } from "./khala-user-priority.js";
import { readLatestVerdict, registerKhalaVerdict } from "./khala-verdict.js";
import { registerKhalaWork } from "./khala-work.js";

const baseDir = dirname(fileURLToPath(import.meta.url));
configureKhalaRuntimePaths({ getAgentDir, configDirName: CONFIG_DIR_NAME });
const packageRoot = resolvePackageRoot(baseDir);

function isTrustedProject(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

const USER_KHALA_TOOL_ALLOWLIST = new Set([
	"khala_oracle",
	"khala_submit_work",
	"khala_read_archive",
	"khala_record_pull_request_review",
	"khala_prioritize_work",
]);
const EXECUTOR_ACTIVE_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"khala_read_archive",
	"khala_signal",
] as const;
const OBSERVER_ACTIVE_TOOLS = ["read", "grep", "find", "ls", "khala_read_archive", "khala_record_learning"] as const;
const PRESERVER_ACTIVE_TOOLS = ["khala_read_archive", "khala_counsel"] as const;

function isDedicatedConclaveSession(context: ExtensionContext): boolean {
	return context.sessionManager
		.getBranch()
		.some((entry) => entry.type === "custom" && entry.customType === KhalaEntryType.conclave);
}

function registerKhalaAttentionControls(
	pi: ExtensionAPI,
	conclaveCoordinator: ConclaveCoordinator,
): (context: ExtensionContext) => Promise<void> {
	const showAttention = (context: ExtensionContext): Promise<void> => {
		const recoverConclave = (recoveryContext: ExtensionContext): Promise<void> =>
			runConclaveRecovery(recoveryContext, conclaveCoordinator);
		if (context.mode === "tui") {
			return showKhalaAttention(context, createObserverViewer(), conclaveCoordinator, recoverConclave);
		}
		return showKhalaAttention(context, undefined, conclaveCoordinator, recoverConclave);
	};
	pi.registerCommand("khala", {
		description: "Show the Khala project attention summary.",
		handler: (_args, context) => showAttention(context),
	});
	pi.registerShortcut(KHALA_TOGGLE_SHORTCUT, {
		description: "Show the Khala project attention summary.",
		handler: (context) => showAttention(context),
	});
	return showAttention;
}

function setRoleActiveTools(pi: ExtensionAPI, role: KhalaRoleValue | null, dedicatedConclave: boolean): void {
	let allowedTools: ReadonlySet<string>;
	if (dedicatedConclave) {
		allowedTools = new Set(CONCLAVE_TOOL_ALLOWLIST);
	} else if (role === KhalaRole.executor) {
		allowedTools = new Set(EXECUTOR_ACTIVE_TOOLS);
	} else if (role === KhalaRole.observer) {
		allowedTools = new Set(OBSERVER_ACTIVE_TOOLS);
	} else if (role === KhalaRole.preserver) {
		allowedTools = new Set(PRESERVER_ACTIVE_TOOLS);
	} else if (role === KhalaRole.conclave) {
		allowedTools = new Set(CONCLAVE_BASE_TOOL_ALLOWLIST);
	} else {
		pi.setActiveTools(
			pi.getActiveTools().filter((name) => !name.startsWith("khala_") || USER_KHALA_TOOL_ALLOWLIST.has(name)),
		);
		return;
	}
	pi.setActiveTools(pi.getActiveTools().filter((name) => allowedTools.has(name)));
}

async function runConclaveRecovery(context: ExtensionContext, conclaveCoordinator: ConclaveCoordinator): Promise<void> {
	try {
		loadKhalaConfig(context.cwd, isTrustedProject(context));
	} catch (error) {
		let message = String(error);
		if (error instanceof Error) {
			({ message } = error);
		}
		context.ui.notify(message, "error");
		return;
	}
	const projectTrusted = isTrustedProject(context);
	const pendingModelRecoveries = listPendingExecutorModelRecoveries(context.cwd, projectTrusted);
	const pending = pendingModelRecoveries.find(
		(candidate) =>
			selectedUserExecutorModelRecovery({
				projectPath: context.cwd,
				workId: candidate.execution.workId,
				missionId: candidate.mission.missionId,
				predecessorExecutionId: candidate.execution.executionId,
				projectTrusted,
			}) === undefined,
	);
	if (pending !== undefined) {
		if (context.mode !== "tui") {
			context.ui.notify(
				`Executor model selection is required for Work ${pending.execution.workId}; use /khala in interactive mode.`,
				"warning",
			);
			return;
		}
		const choseModel = await selectExecutorRecoveryModel(
			{
				workId: pending.execution.workId,
				missionId: pending.mission.missionId,
				executionId: pending.execution.executionId,
			},
			context,
			conclaveCoordinator,
		);
		if (!choseModel) {
			return;
		}
	}
	let userSessionPath: string | undefined;
	if (!isDedicatedConclaveSession(context)) {
		userSessionPath = context.sessionManager.getSessionFile();
	}
	const sessionPath = conclaveCoordinator.ensureConclaveSession(context.cwd, userSessionPath, projectTrusted);
	conclaveCoordinator.resume(context.cwd, projectTrusted);
	if (sessionPath === undefined) {
		context.ui.notify("Khala could not create the project Conclave.", "error");
	} else {
		context.ui.notify("Khala configuration is valid; pending Work recovery was scheduled.", "info");
	}
}

function registerConclaveRecovery(pi: ExtensionAPI, conclaveCoordinator: ConclaveCoordinator): void {
	pi.registerCommand("khala-recover", {
		description: "Recover the project Conclave and resume pending Work.",
		handler: (_args, context) => runConclaveRecovery(context, conclaveCoordinator),
	});
}

function createExtension(pi: ExtensionAPI): void {
	const conclaveCoordinator = createConclaveCoordinator(resolveExtensionPath(baseDir));
	registerKhalaDynamicResources(pi);
	registerKhalaFlags(pi);
	registerKhalaTools(pi, conclaveCoordinator);
	const showAttention = registerKhalaAttentionControls(pi, conclaveCoordinator);
	registerKhalaSessionEvents(pi, showAttention, conclaveCoordinator);
}

function registerKhalaDynamicResources(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({
		promptPaths: [join(packageRoot, "templates", "khala-triage-prompt.md")],
	}));
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

function registerKhalaTools(pi: ExtensionAPI, conclaveCoordinator: ConclaveCoordinator): void {
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
		createObserverCloser(),
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
	registerKhalaOracle(pi);
	registerKhalaCounsel(pi, (context) => readSessionRole(context) === KhalaRole.preserver);
	registerKhalaVerdict(pi, isDedicatedConclaveSession, conclaveCoordinator.deliverVerdict);
	registerKhalaReview(pi, isDedicatedConclaveSession, (projectPath, workId, projectTrusted) =>
		conclaveCoordinator.wakeReview(projectPath, workId, projectTrusted),
	);
	registerKhalaSupervisionTools(pi, {
		isDedicatedConclaveSession,
		registerStopHandoffExpectation: (context, expectation) =>
			getSupervisionController(context.cwd, isTrustedProject(context))?.registerStopHandoffExpectation(expectation),
	});
	registerKhalaUserPriority(pi, { wakeUserPriority: conclaveCoordinator.wakeUserPriority });
	registerConclaveRecovery(pi, conclaveCoordinator);
}

function registerKhalaSessionEvents(
	pi: ExtensionAPI,
	showAttention: (context: ExtensionContext) => Promise<void>,
	conclaveCoordinator: ConclaveCoordinator,
): void {
	pi.on("session_start", (_event, context) => {
		registerLaunchedAgent(pi, context);
		const role = readSessionRole(context);
		const dedicatedConclave = isDedicatedConclaveSession(context) && role === KhalaRole.conclave;
		registerRoleKhalaArchiveRead(pi, readSessionRole, role);
		setRoleActiveTools(pi, role, dedicatedConclave);
		queueMicrotask(() => setRoleActiveTools(pi, role, dedicatedConclave));
		setKhalaStatus(context, role);
		if (!isDedicatedConclaveSession(context)) {
			conclaveCoordinator.resume(context.cwd, isTrustedProject(context));
		}
	});
	pi.on("session_shutdown", () => conclaveCoordinator.dispose());
	registerConfiguredKhalaWork(pi, conclaveCoordinator);
	registerKhalaTriage(pi);
	registerKhalaDemo(pi, {
		ensureConclaveSession: conclaveCoordinator.ensureConclaveSession,
		submitWork: conclaveCoordinator.submit,
		openAttention: showAttention,
	});
	pi.on("message_end", (event, context) => {
		const entries = context.sessionManager.getEntries();
		const previousEntry = entries.at(-1);
		const assessmentInputIndex = [...entries]
			.map((entry, index) => ({ entry, index }))
			.reverse()
			.find(
				(candidate) =>
					candidate.entry.type === "custom_message" &&
					candidate.entry.customType === "khala-supervision-assessment-input",
			)?.index;
		let assessmentInput: (typeof entries)[number] | undefined;
		if (assessmentInputIndex !== undefined) {
			assessmentInput = entries[assessmentInputIndex];
		}
		let assessmentDetails: Record<string, unknown> | undefined;
		if (
			assessmentInput?.type === "custom_message" &&
			typeof assessmentInput.details === "object" &&
			assessmentInput.details !== null
		) {
			assessmentDetails = assessmentInput.details as Record<string, unknown>;
		}
		let assessmentEntries: typeof entries = [];
		if (assessmentInputIndex !== undefined) {
			assessmentEntries = entries.slice(assessmentInputIndex + 1);
		}
		const assessmentHasDirectUserInput = assessmentEntries.some(
			(entry) => entry.type === "message" && entry.message.role === "user",
		);
		let activeAssessmentInput: typeof assessmentInput;
		if (!assessmentHasDirectUserInput) {
			activeAssessmentInput = assessmentInput;
		}
		const assessmentToolCalls = assessmentEntries.flatMap((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant") {
				return [];
			}
			return toolCallsFromMessage(entry.message);
		});
		const significantAction = assessmentEntries.some((entry) => {
			if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) {
				return false;
			}
			return entry.message.content.some((content) => {
				if (typeof content !== "object" || content === null || (content as { type?: unknown }).type !== "toolCall") {
					return false;
				}
				const { name } = content as { name?: unknown };
				return typeof name === "string" && name !== "khala_read_archive";
			});
		});
		const { budgetOverrun } = assessmentDetails ?? {};
		const visibilityContext: {
			significantAction: boolean;
			budgetOverrun: boolean;
			toolCalls: typeof assessmentToolCalls;
			assessmentInput?: NonNullable<typeof assessmentInput>;
		} = {
			significantAction,
			budgetOverrun: budgetOverrun === true,
			toolCalls: assessmentToolCalls,
		};
		if (activeAssessmentInput !== undefined) {
			visibilityContext.assessmentInput = activeAssessmentInput;
		}
		const replacement = hideAlignedAssessmentResponse(event.message, previousEntry, visibilityContext);
		if (replacement !== undefined) {
			return { message: replacement };
		}
		return { message: event.message };
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
			projectPath: string;
			projectTrusted: boolean;
			kind: string;
			missionId?: string;
			mandateId?: string;
			participantId?: string;
		} = { workId, executionId, projectPath, projectTrusted, kind: agentKind };
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
			// The Observer marker carries the role-specific observerName identity consumed by khala_record_learning.
			pi.appendEntry(KhalaEntryType.observer, { ...marker, observerName: executorName });
		} else {
			pi.appendEntry(KhalaEntryType.executor, { ...marker, executorName });
		}
	}
	const sessionPath = context.sessionManager.getSessionFile();
	const sessionManagerWithId = context.sessionManager as unknown as { getSessionId?: () => string };
	const sessionId = sessionManagerWithId.getSessionId?.();
	if (sessionPath !== undefined && sessionId !== undefined && sessionId.length > 0) {
		updateExecutorRecord(projectPath, executionId, { piSessionId: sessionId, sessionPath }, projectTrusted);
	}
	// biome-ignore lint/style/useNamingConvention: Match the Observer bootstrap environment contract.
	const startupEnvironment = process.env as Readonly<{ KHALA_STARTUP_MARKER?: string }>;
	const startupMarker = startupEnvironment.KHALA_STARTUP_MARKER;
	if (typeof startupMarker === "string" && startupMarker.length > 0) {
		try {
			writeFileSync(startupMarker, "ready", "utf8");
		} catch {
			// The launcher timeout remains actionable if the sandbox disappears during startup.
		}
	}
}

function registerConfiguredKhalaWork(pi: ExtensionAPI, conclaveCoordinator: ConclaveCoordinator): void {
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
		pollBeforeDependentLaunch: (projectPath, projectTrusted, workId) =>
			conclaveCoordinator.pollBeforeDependentLaunch(projectPath, projectTrusted, workId),
	});
}

export { createExtension as default };
