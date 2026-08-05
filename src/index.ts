// biome-ignore-all lint/style/noExcessiveLinesPerFile: Extension registration keeps role and lifecycle wiring together.
// biome-ignore-all lint/style/noProcessEnv: Observer startup readiness is passed through the child process environment.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Extension hooks compose role, lifecycle, and durable delivery fences.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Extension hooks compose role, lifecycle, and durable delivery fences.
import { createHash } from "node:crypto";
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
import { listExecutorRecords, readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import { KHALA_TOGGLE_SHORTCUT } from "./khala-keybindings.js";
import { registerKhalaLearning } from "./khala-learning.js";
import { ExecutorStatus } from "./khala-model.js";
import { registerKhalaObserver } from "./khala-observer.js";
import { registerKhalaOracle } from "./khala-oracle.js";
import { resolveExtensionPath, resolvePackageRoot } from "./khala-package.js";
import { toggleKhalaPopup } from "./khala-popup.js";
import { registerKhalaReview } from "./khala-review.js";
import { KhalaRole, type KhalaRoleValue, readRolePrompt, readSessionRole } from "./khala-role.js";
import type { KhalaSession } from "./khala-sessions.js";
import { createSessionSource } from "./khala-sessions.js";
import { registerKhalaSignal } from "./khala-signal.js";
import { setKhalaStatus } from "./khala-status.js";
import {
	deterministicActionId,
	deterministicAssessmentId,
	getSupervisionController,
	hideAlignedAssessmentResponse,
	toolCallsFromMessage,
} from "./khala-supervision.js";
import { DIRECT_USER_SOURCE_ENTRY, registerKhalaSupervisionTools } from "./khala-supervision-tools.js";
import { registerKhalaTriage } from "./khala-triage.js";
import { readLatestVerdict, registerKhalaVerdict } from "./khala-verdict.js";
import { registerKhalaWork } from "./khala-work.js";

const baseDir = dirname(fileURLToPath(import.meta.url));
configureKhalaRuntimePaths({ getAgentDir, configDirName: CONFIG_DIR_NAME });
const packageRoot = resolvePackageRoot(baseDir);
const pendingDirectInteractiveInputs = new WeakMap<object, PendingDirectInteractiveInput[]>();
const pendingDirectUserAssessments = new WeakMap<object, DirectUserAssessmentStart[]>();
const USER_KHALA_TOOL_ALLOWLIST = new Set([
	"khala_oracle",
	"khala_submit_work",
	"khala_read_archive",
	"khala_record_pull_request_review",
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

type PendingDirectInteractiveInput = Readonly<{
	sessionId: string;
	contentSha256: string;
	assessmentId?: string;
	assessmentStartEntryId?: string;
}>;

type DirectUserAssessmentStart = Readonly<{
	assessmentId: string;
	workId: string;
	missionId: string;
	executionId: string;
	firstSourceEntryId: string;
	lastSourceEntryId: string;
	sourceEntryIds: readonly string[];
	actionIdNamespace: string;
	actionIdPattern: string;
	sourceKind: "direct-user";
}>;

function isTrustedProject(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function messageContentSha256(content: unknown): string {
	if (typeof content === "string") {
		return sha256(content);
	}
	return sha256(JSON.stringify(content));
}

function isSlashCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

function currentIncompleteAssessment(context: ExtensionContext): { assessmentId: string; entryId: string } | undefined {
	const entries = context.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			entry?.type === "custom" &&
			entry.customType === "khala-supervision-assessment-start" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			(entry.data as { sourceKind?: unknown }).sourceKind !== "direct-user" &&
			typeof (entry.data as { assessmentId?: unknown }).assessmentId === "string"
		) {
			const { assessmentId } = entry.data as { assessmentId: string };
			const complete = entries.some(
				(candidate) =>
					candidate.type === "custom" &&
					candidate.customType === "khala-supervision-assessment-complete" &&
					typeof candidate.data === "object" &&
					candidate.data !== null &&
					(candidate.data as { assessmentId?: unknown }).assessmentId === assessmentId,
			);
			if (!complete) {
				return { assessmentId, entryId: entry.id };
			}
		}
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy the non-void union return contract.
	return undefined;
}

function createDirectUserAssessments(context: ExtensionContext, userEntryId: string): DirectUserAssessmentStart[] {
	return listExecutorRecords(context.cwd, isTrustedProject(context)).flatMap((execution) => {
		if (
			execution.kind !== "executor" ||
			execution.missionId === undefined ||
			(execution.status !== ExecutorStatus.starting && execution.status !== ExecutorStatus.running)
		) {
			return [];
		}
		const assessmentId = deterministicAssessmentId(execution.executionId, userEntryId, userEntryId);
		return [
			{
				assessmentId,
				workId: execution.workId,
				missionId: execution.missionId,
				executionId: execution.executionId,
				firstSourceEntryId: userEntryId,
				lastSourceEntryId: userEntryId,
				sourceEntryIds: [userEntryId],
				actionIdNamespace: `action:${assessmentId}:`,
				// biome-ignore lint/security/noSecrets: This is a documented deterministic ID pattern, not a credential.
				actionIdPattern: "action-<sha256(assessmentId\\u0000actionKind\\u0000ordinal)>",
				sourceKind: "direct-user" as const,
			},
		];
	});
}

function settleStaleDirectUserAssessments(pi: ExtensionAPI, context: ExtensionContext): void {
	const branch = context.sessionManager.getBranch();
	const completed = new Set(
		branch.flatMap((entry) => {
			if (
				entry.type !== "custom" ||
				entry.customType !== "khala-supervision-assessment-complete" ||
				typeof entry.data !== "object" ||
				entry.data === null ||
				typeof (entry.data as { assessmentId?: unknown }).assessmentId !== "string"
			) {
				return [];
			}
			return [(entry.data as { assessmentId: string }).assessmentId];
		}),
	);
	for (const entry of branch) {
		if (
			entry.type === "custom" &&
			entry.customType === "khala-supervision-assessment-start" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			(entry.data as { sourceKind?: unknown }).sourceKind === "direct-user" &&
			typeof (entry.data as { assessmentId?: unknown }).assessmentId === "string" &&
			!completed.has((entry.data as { assessmentId: string }).assessmentId)
		) {
			pi.appendEntry("khala-supervision-assessment-complete", entry.data);
		}
	}
}

function isDedicatedConclaveSession(context: ExtensionContext): boolean {
	return context.sessionManager
		.getBranch()
		.some((entry) => entry.type === "custom" && entry.customType === KhalaEntryType.conclave);
}

function createObserverViewHandler(
	context: ExtensionContext,
	viewObserver: ReturnType<typeof createObserverViewer> | undefined,
): ((session: KhalaSession) => Promise<void>) | undefined {
	if (viewObserver === undefined) {
		return;
	}
	return async (session) => {
		if (session.role !== "Observer" || session.launcher === undefined || session.target === undefined) {
			return;
		}
		try {
			await viewObserver(session.launcher, session.target);
		} catch {
			// Viewing is a UI operation. A failed focus/attach must not rewrite the
			// durable Observer execution state.
			context.ui.notify(`The ${session.name} Observer pane could not be focused.`, "warning");
		}
	};
}

function registerPopupControls(
	pi: ExtensionAPI,
	conclaveCoordinator: ConclaveCoordinator,
): (context: ExtensionContext) => Promise<void> {
	const showPopup = (context: ExtensionContext, onSwitch?: (path: string) => Promise<unknown>): Promise<void> => {
		let userSessionPath: string | undefined;
		if (!isDedicatedConclaveSession(context)) {
			userSessionPath = context.sessionManager.getSessionFile();
		}
		conclaveCoordinator.ensureConclaveSession(context.cwd, userSessionPath, isTrustedProject(context));
		let viewObserver: ReturnType<typeof createObserverViewer> | undefined;
		if (context.mode === "tui") {
			viewObserver = createObserverViewer();
		}
		return toggleKhalaPopup(
			context,
			createSessionSource(
				context,
				conclaveCoordinator.getConclaveSessionPath,
				conclaveCoordinator.getConclaveUserSessionPath,
			),
			onSwitch,
			createObserverViewHandler(context, viewObserver),
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

function registerConclaveRecovery(pi: ExtensionAPI, conclaveCoordinator: ConclaveCoordinator): void {
	pi.registerCommand("khala-recreate", {
		description: "Recover the project Conclave and resume pending Work.",
		handler: (args, context) => {
			if (args.trim().length > 0) {
				context.ui.notify("Usage: /khala-recreate", "warning");
				return Promise.resolve();
			}
			try {
				loadKhalaConfig(context.cwd, isTrustedProject(context));
			} catch (error) {
				let message = String(error);
				if (error instanceof Error) {
					({ message } = error);
				}
				context.ui.notify(message, "error");
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
				context.ui.notify("Khala configuration is valid; pending Work recovery was scheduled.", "info");
			}
			return Promise.resolve();
		},
	});
}

function createExtension(pi: ExtensionAPI): void {
	const conclaveCoordinator = createConclaveCoordinator(resolveExtensionPath(baseDir));
	registerKhalaDynamicResources(pi);
	registerKhalaFlags(pi);
	registerKhalaTools(pi, conclaveCoordinator);
	const showKhalaPopup = registerPopupControls(pi, conclaveCoordinator);
	registerKhalaSessionEvents(pi, showKhalaPopup, conclaveCoordinator);
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
	registerKhalaVerdict(
		pi,
		isDedicatedConclaveSession,
		conclaveCoordinator.requeueSubmission,
		conclaveCoordinator.deliverVerdict,
	);
	registerKhalaReview(pi, isDedicatedConclaveSession, (projectPath, workId, projectTrusted) =>
		conclaveCoordinator.wakeReview(projectPath, workId, projectTrusted),
	);
	registerKhalaSupervisionTools(pi, {
		isDedicatedConclaveSession,
		registerStopHandoffExpectation: (context, expectation) =>
			getSupervisionController(context.cwd, isTrustedProject(context))?.registerStopHandoffExpectation(expectation),
	});
	registerConclaveRecovery(pi, conclaveCoordinator);
}

function registerKhalaSessionEvents(
	pi: ExtensionAPI,
	showKhalaPopup: (context: ExtensionContext) => Promise<void>,
	conclaveCoordinator: ConclaveCoordinator,
): void {
	pi.on("session_start", (_event, context) => {
		settleStaleDirectUserAssessments(pi, context);
		const role = readSessionRole(context);
		const dedicatedConclave = isDedicatedConclaveSession(context) && role === KhalaRole.conclave;
		registerRoleKhalaArchiveRead(pi, readSessionRole, role);
		setRoleActiveTools(pi, role, dedicatedConclave);
		queueMicrotask(() => setRoleActiveTools(pi, role, dedicatedConclave));
		registerLaunchedAgent(pi, context);
		setKhalaStatus(context, readSessionRole(context));
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
		openMonitor: showKhalaPopup,
	});
	pi.on("input", (event, context) => {
		if (event.source === "interactive" && isDedicatedConclaveSession(context)) {
			const key = context.sessionManager as object;
			if (isSlashCommand(event.text)) {
				pendingDirectInteractiveInputs.delete(key);
			} else {
				const assessment = currentIncompleteAssessment(context);
				const sessionId = context.sessionManager.getSessionId();
				const pending = pendingDirectInteractiveInputs.get(key) ?? [];
				let directInput: PendingDirectInteractiveInput = {
					sessionId,
					contentSha256: sha256(event.text),
				};
				if (assessment !== undefined) {
					directInput = {
						...directInput,
						assessmentId: assessment.assessmentId,
						assessmentStartEntryId: assessment.entryId,
					};
				}
				pending.push(directInput);
				pendingDirectInteractiveInputs.set(key, pending);
				getSupervisionController(context.cwd, isTrustedProject(context))?.noteDirectUserInput();
			}
		}
		return { action: "continue" };
	});
	pi.on("message_end", (event, context) => {
		if (event.message.role === "user" && isDedicatedConclaveSession(context)) {
			const key = context.sessionManager as object;
			const pending = pendingDirectInteractiveInputs.get(key) ?? [];
			const contentSha256 = messageContentSha256(event.message.content);
			const pendingIndex = pending.findIndex(
				(candidate) =>
					candidate.sessionId === context.sessionManager.getSessionId() && candidate.contentSha256 === contentSha256,
			);
			if (pendingIndex >= 0) {
				const candidate = pending[pendingIndex] as PendingDirectInteractiveInput;
				const entries = context.sessionManager.getEntries();
				const userEntry = entries.at(-1);
				if (
					userEntry?.type === "message" &&
					userEntry.message.role === "user" &&
					messageContentSha256(userEntry.message.content) === contentSha256
				) {
					if (candidate.assessmentId !== undefined && candidate.assessmentStartEntryId !== undefined) {
						pi.appendEntry(DIRECT_USER_SOURCE_ENTRY, {
							entryId: userEntry.id,
							source: "interactive",
							sessionId: candidate.sessionId,
							contentSha256,
							assessmentId: candidate.assessmentId,
							assessmentStartEntryId: candidate.assessmentStartEntryId,
						});
					} else {
						const directAssessments = createDirectUserAssessments(context, userEntry.id);
						for (const assessment of directAssessments) {
							pi.appendEntry("khala-supervision-assessment-start", assessment);
							const assessmentStartEntry = context.sessionManager.getEntries().at(-1);
							if (
								assessmentStartEntry?.type !== "custom" ||
								assessmentStartEntry.customType !== "khala-supervision-assessment-start"
							) {
								throw new Error("Direct User assessment start was not persisted.");
							}
							pi.appendEntry(DIRECT_USER_SOURCE_ENTRY, {
								entryId: userEntry.id,
								source: "interactive",
								sessionId: candidate.sessionId,
								contentSha256,
								assessmentId: assessment.assessmentId,
								assessmentStartEntryId: assessmentStartEntry.id,
							});
						}
						if (directAssessments.length > 0) {
							const pendingAssessments = pendingDirectUserAssessments.get(key) ?? [];
							pendingDirectUserAssessments.set(key, [...pendingAssessments, ...directAssessments]);
						}
					}
				}
				pending.splice(pendingIndex, 1);
				if (pending.length === 0) {
					pendingDirectInteractiveInputs.delete(key);
				} else {
					pendingDirectInteractiveInputs.set(key, pending);
				}
			}
		}

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
	pi.on("context", (event, context) => {
		if (!isDedicatedConclaveSession(context)) {
			return;
		}
		const branch = context.sessionManager.getBranch();
		const completed = new Set<string>();
		for (const entry of branch) {
			if (
				entry.type === "custom" &&
				entry.customType === "khala-supervision-assessment-complete" &&
				typeof entry.data === "object" &&
				entry.data !== null &&
				typeof (entry.data as { assessmentId?: unknown }).assessmentId === "string"
			) {
				completed.add((entry.data as { assessmentId: string }).assessmentId);
			}
		}
		const directAssessments = branch.flatMap((entry) => {
			if (
				entry.type !== "custom" ||
				entry.customType !== "khala-supervision-assessment-start" ||
				typeof entry.data !== "object" ||
				entry.data === null ||
				(entry.data as { sourceKind?: unknown }).sourceKind !== "direct-user"
			) {
				return [];
			}
			const assessment = entry.data as DirectUserAssessmentStart;
			if (completed.has(assessment.assessmentId)) {
				return [];
			}
			const marker = branch.find(
				(candidate) =>
					candidate.type === "custom" &&
					candidate.customType === DIRECT_USER_SOURCE_ENTRY &&
					typeof candidate.data === "object" &&
					candidate.data !== null &&
					(candidate.data as { assessmentId?: unknown }).assessmentId === assessment.assessmentId,
			);
			if (marker?.type !== "custom" || typeof marker.data !== "object" || marker.data === null) {
				return [];
			}
			const userEntryId = (marker.data as { entryId?: unknown }).entryId;
			if (typeof userEntryId !== "string") {
				return [];
			}
			return [{ assessment, userEntryId }];
		});
		if (directAssessments.length === 0) {
			return;
		}
		const guidance = directAssessments.flatMap(({ assessment, userEntryId }) => [
			`Target Work ${assessment.workId}, Mission ${assessment.missionId}, Execution ${assessment.executionId}:`,
			`userEntryId=${userEntryId}`,
			`assessmentId=${assessment.assessmentId}`,
			`coordinate-override actionId=${deterministicActionId(assessment.assessmentId, "coordinate-override")}`,
		]);
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					customType: "khala-direct-user-action-context",
					content: [
						"Runtime-verified direct User provenance for this turn follows.",
						"Use only the matching target if the User explicitly changes peer-conflict priority.",
						...guidance,
					].join("\n"),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});
	pi.on("agent_settled", (_event, context) => {
		const key = context.sessionManager as object;
		const pending = pendingDirectUserAssessments.get(key);
		if (pending === undefined) {
			return;
		}
		pendingDirectUserAssessments.delete(key);
		const branch = context.sessionManager.getBranch();
		for (const assessment of pending) {
			const alreadyComplete = branch.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === "khala-supervision-assessment-complete" &&
					typeof entry.data === "object" &&
					entry.data !== null &&
					(entry.data as { assessmentId?: unknown }).assessmentId === assessment.assessmentId,
			);
			if (!alreadyComplete) {
				pi.appendEntry("khala-supervision-assessment-complete", assessment);
			}
		}
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

export { createExtension as default, createObserverViewHandler };
