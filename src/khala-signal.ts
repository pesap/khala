import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { appendArchiveRecord } from "./khala-archive.js";
import { listSignalRecords, readCurrentMission, readMandate } from "./khala-archive-projections.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import type { SignalRecord } from "./khala-model.js";
import { KhalaRole, readSessionRole } from "./khala-role.js";

const SIGNAL_PARAMETERS = Type.Object({
	kind: Type.Union([Type.Literal("progress"), Type.Literal("blocked"), Type.Literal("finished")]),
	summary: Type.String(),
	evidence: Type.Array(Type.String()),
});
type SignalInput = Static<typeof SIGNAL_PARAMETERS>;
type SignalWake = (projectPath: string, signal: SignalRecord, projectTrusted?: boolean) => Promise<void> | void;
type SignalFinalize = (projectPath: string, signal: SignalRecord, projectTrusted?: boolean) => Promise<void> | void;

type ExecutorMarker = Readonly<{
	workId?: unknown;
	executionId?: unknown;
	executorName?: unknown;
	projectPath?: unknown;
	projectTrusted?: unknown;
	missionId?: unknown;
	participantId?: unknown;
	mandateId?: unknown;
}>;

type ExecutorBinding = Readonly<{
	workId: string;
	executionId: string;
	executorName: string;
	projectPath: string;
	projectTrusted?: boolean;
	missionId?: string;
	participantId?: string;
	mandateId?: string;
}>;

function registerKhalaSignal(pi: ExtensionAPI, wake: SignalWake, finalize?: SignalFinalize): void {
	pi.registerTool({
		name: "khala_signal",
		label: "Submit Khala Signal",
		description: "Submit an evidence-bearing progress, blocked, or finished Signal for the current Executor execution.",
		promptSnippet: "Submit an evidence-bearing Khala Executor Signal",
		parameters: SIGNAL_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return submitSignal(params, context, wake, finalize);
		},
	});
}

function submitSignal(params: SignalInput, context: ExtensionContext, wake: SignalWake, finalize?: SignalFinalize) {
	const execution = validateSignalExecution(context);
	const { binding, projectPath, projectTrusted, missionId, participantId } = execution;

	const summary = params.summary.trim();
	const evidence = params.evidence.map((item) => item.trim()).filter((item) => item.length > 0);
	if (summary.length === 0 || evidence.length === 0) {
		throw new Error("A Signal requires a non-empty summary and at least one evidence item.");
	}
	const signal = createSignal({ binding, kind: params.kind, summary, evidence, missionId, participantId });
	let schemaVersion: 1 | 2 = 1;
	if (missionId !== undefined) {
		schemaVersion = 2;
	}
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion,
			type: "signal",
			workId: signal.workId,
			executionId: signal.executionId,
			payload: signal,
		},
		projectTrusted,
	);
	updateExecutorRecord(projectPath, signal.executionId, { lastSignalAt: signal.observedAt }, projectTrusted);
	let finalizationError: string | undefined;
	let wakeError: string | undefined;
	let finalization = Promise.resolve();
	if (finalize !== undefined) {
		finalization = Promise.resolve(finalize(projectPath, signal, projectTrusted)).catch((error: unknown) => {
			if (error instanceof Error) {
				finalizationError = error.message;
			} else {
				finalizationError = String(error);
			}
		});
	}
	return finalization
		.then(() => wake(projectPath, signal, projectTrusted))
		.catch((error: unknown) => {
			if (error instanceof Error) {
				wakeError = error.message;
			} else {
				wakeError = String(error);
			}
		})
		.then(() => {
			let text = `Signal ${signal.signalId} recorded.`;
			if (wakeError === undefined) {
				text += " The Conclave was woken.";
			} else {
				text += ` Conclave wake failed: ${wakeError}`;
			}
			if (finalizationError !== undefined) {
				text += ` Review evidence update failed: ${finalizationError}`;
			}
			return {
				content: [{ type: "text" as const, text }],
				details: signal,
			};
		});
}

type SignalExecution = Readonly<{
	binding: ExecutorBinding;
	projectPath: string;
	projectTrusted: boolean;
	missionId?: string;
	participantId?: string;
}>;

function validateSignalExecution(context: ExtensionContext): SignalExecution {
	if (readSessionRole(context) !== KhalaRole.executor) {
		throw new Error("Only a Khala Executor session may submit a Signal.");
	}
	const binding = readExecutorBinding(context);
	if (binding === undefined) {
		throw new Error("This session is not bound to a registered Khala Executor execution.");
	}
	const projectPath = resolve(binding.projectPath);
	let projectTrusted = isProjectTrusted(context);
	const { projectTrusted: boundProjectTrusted } = binding;
	if (boundProjectTrusted !== undefined) {
		projectTrusted = boundProjectTrusted;
	}
	const registry = readExecutorRecord(projectPath, binding.executionId, projectTrusted);
	if (registry === undefined || resolve(registry.projectPath) !== projectPath) {
		throw new Error("The Executor marker does not match its registered Project execution.");
	}
	if (resolve(registry.sandboxPath) !== resolve(context.cwd)) {
		throw new Error("The Executor session sandbox does not match its registered sandbox.");
	}
	const sessionPath = context.sessionManager.getSessionFile();
	if (
		registry.status !== "running" ||
		registry.workId !== binding.workId ||
		registry.executorName !== binding.executorName ||
		(registry.sessionPath !== undefined && registry.sessionPath !== sessionPath)
	) {
		throw new Error("Only a running Executor execution may submit a Signal.");
	}
	const missionBinding = validateMissionSignalExecution(binding, registry, projectPath, projectTrusted);
	return { binding, projectPath, projectTrusted, ...missionBinding };
}

function validateMissionSignalExecution(
	binding: ExecutorBinding,
	registry: NonNullable<ReturnType<typeof readExecutorRecord>>,
	projectPath: string,
	projectTrusted: boolean,
): Pick<SignalExecution, "missionId" | "participantId"> {
	if (registry.purpose?.kind !== "mission") {
		return {};
	}
	const { missionId } = registry.purpose;
	const { participantId } = registry;
	if (
		missionId === undefined ||
		participantId === undefined ||
		binding.missionId !== missionId ||
		binding.participantId !== participantId ||
		registry.missionId !== missionId
	) {
		throw new Error("The Signal fails the Mission and participant assignment fence.");
	}
	const mission = readCurrentMission(projectPath, binding.workId, projectTrusted);
	if (mission === undefined || mission.state !== "current" || mission.mission.missionId !== missionId) {
		throw new Error("The Signal references a stale or terminal Mission.");
	}
	const mandate = readMandate(projectPath, mission.mission.mandateId, projectTrusted);
	if (mandate === undefined || mandate.workId !== binding.workId) {
		throw new Error("The Signal's governing Mandate is unavailable.");
	}
	return { missionId, participantId };
}

function createSignal(input: {
	binding: ExecutorBinding;
	kind: SignalInput["kind"];
	summary: string;
	evidence: readonly string[];
	missionId: string | undefined;
	participantId: string | undefined;
}): SignalRecord {
	const base = {
		signalId: nanoid(),
		workId: input.binding.workId,
		executionId: input.binding.executionId,
		executorName: input.binding.executorName,
		kind: input.kind,
		summary: input.summary,
		evidence: input.evidence,
		observedAt: new Date().toISOString(),
	};
	if (input.missionId === undefined || input.participantId === undefined) {
		return base;
	}
	return { ...base, missionId: input.missionId, participantId: input.participantId };
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function readExecutorBinding(context: ExtensionContext): ExecutorBinding | undefined {
	let binding: ExecutorBinding | undefined;
	for (const entry of context.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === KhalaEntryType.executor) {
			binding = parseExecutorBinding(entry.data);
			if (binding !== undefined) {
				return binding;
			}
		}
	}
	return binding;
}

function parseExecutorBinding(input: unknown): ExecutorBinding | undefined {
	const data = input as ExecutorMarker;
	if (
		typeof data.workId !== "string" ||
		typeof data.executionId !== "string" ||
		typeof data.executorName !== "string" ||
		typeof data.projectPath !== "string"
	) {
		return;
	}
	const binding: {
		workId: string;
		executionId: string;
		executorName: string;
		projectPath: string;
		projectTrusted?: boolean;
		missionId?: string;
		participantId?: string;
		mandateId?: string;
	} = {
		workId: data.workId,
		executionId: data.executionId,
		executorName: data.executorName,
		projectPath: data.projectPath,
	};
	if (typeof data.projectTrusted === "boolean") {
		binding.projectTrusted = data.projectTrusted;
	}
	if (typeof data.missionId === "string") {
		binding.missionId = data.missionId;
	}
	if (typeof data.participantId === "string") {
		binding.participantId = data.participantId;
	}
	if (typeof data.mandateId === "string") {
		binding.mandateId = data.mandateId;
	}
	return binding;
}

function readSignal(projectPath: string, signalId: string, projectTrusted = false): SignalRecord | undefined {
	let signal: SignalRecord | undefined;
	for (const candidate of listSignalRecords(projectPath, projectTrusted)) {
		if (candidate.signalId === signalId) {
			signal = candidate;
		}
	}
	return signal;
}

function listSignals(projectPath: string, projectTrusted = false): SignalRecord[] {
	return listSignalRecords(projectPath, projectTrusted);
}

export type { SignalInput, SignalWake };
export { listSignals, readSignal, registerKhalaSignal, submitSignal };
