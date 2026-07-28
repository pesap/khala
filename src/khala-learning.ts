import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { appendArchiveRecord } from "./khala-archive.js";
import { listLearningRecordsFromArchive } from "./khala-archive-projections.js";
import { LauncherName } from "./khala-config.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import type { ExecutorCloser } from "./khala-executor.js";
import { readExecutorRecord, updateExecutorRecord } from "./khala-executor-registry.js";
import type { LearningRecord } from "./khala-model.js";
import { KhalaRole, readSessionRole } from "./khala-role.js";

const LEARNING_PARAMETERS = Type.Object({
	workId: Type.String(),
	executionId: Type.String(),
	topic: Type.String(),
	summary: Type.String(),
	evidence: Type.Array(Type.String()),
	sourcePaths: Type.Array(Type.String()),
});
type LearningInput = Static<typeof LEARNING_PARAMETERS>;
type LearningWake = (projectPath: string, learning: LearningRecord, projectTrusted?: boolean) => Promise<void>;

type ObserverBinding = Readonly<{
	workId: string;
	executionId: string;
	observerName: string;
	projectPath: string;
}>;

function registerKhalaLearning(pi: ExtensionAPI, wake: LearningWake, closeObserver: ExecutorCloser): void {
	pi.registerTool({
		name: "khala_record_learning",
		label: "Record Khala Learning",
		description: "Record evidence-backed repository learning for the Conclave.",
		promptSnippet: "Record evidence-backed Khala learning",
		parameters: LEARNING_PARAMETERS,
		// biome-ignore lint/complexity/useMaxParams: Pi defines the tool callback with five positional parameters.
		execute: (_toolCallId, params, _signal, _onUpdate, context) => recordLearning(params, context, wake, closeObserver),
	});
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Learning recording keeps authorization, durability, wake, and cleanup atomic.
async function recordLearning(
	params: LearningInput,
	context: ExtensionContext,
	wake: LearningWake,
	closeObserver: ExecutorCloser,
): Promise<{ content: [{ type: "text"; text: string }]; details: LearningRecord }> {
	if (readSessionRole(context) !== KhalaRole.observer) {
		throw new Error("Only a Khala Observer session may record Learning.");
	}
	const binding = readObserverBinding(context);
	if (binding === undefined) {
		throw new Error("This session is not bound to a Khala Observer execution.");
	}
	if (
		binding.projectPath !== context.cwd ||
		binding.workId !== params.workId ||
		binding.executionId !== params.executionId
	) {
		throw new Error("Learning must reference the current Observer Work and execution.");
	}
	const projectPath = context.cwd;
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const execution = readExecutorRecord(projectPath, binding.executionId, projectTrusted);
	const sessionPath = context.sessionManager.getSessionFile();
	if (
		execution === undefined ||
		execution.kind !== "observer" ||
		execution.purpose?.kind !== "observation" ||
		execution.status !== "running" ||
		(execution.sessionPath !== undefined && execution.sessionPath !== sessionPath)
	) {
		throw new Error("The Observer execution is not registered to this session.");
	}
	const topic = params.topic.trim();
	const summary = params.summary.trim();
	const evidence = params.evidence.map((item) => item.trim()).filter((item) => item.length > 0);
	const sourcePaths = params.sourcePaths.map((item) => item.trim()).filter((item) => item.length > 0);
	if (topic.length === 0 || summary.length === 0 || evidence.length === 0 || sourcePaths.length === 0) {
		throw new Error("Learning requires a topic, summary, evidence, and at least one source path.");
	}
	const learning: LearningRecord = {
		learningId: nanoid(),
		workId: params.workId,
		executionId: params.executionId,
		observerName: binding.observerName,
		topic,
		summary,
		evidence,
		sourcePaths,
		createdAt: new Date().toISOString(),
	};
	appendArchiveRecord(
		projectPath,
		{
			schemaVersion: 2,
			type: "learning",
			workId: learning.workId,
			executionId: learning.executionId,
			payload: learning,
		},
		projectTrusted,
	);
	updateExecutorRecord(projectPath, learning.executionId, { status: "finished" }, projectTrusted);
	await wake(projectPath, learning, projectTrusted);
	if (
		execution.target !== undefined &&
		(execution.launcher === LauncherName.zellij ||
			execution.launcher === LauncherName.tmux ||
			execution.launcher === LauncherName.herdr)
	) {
		try {
			await closeObserver(execution.launcher, execution.target);
		} catch {
			// Learning is durable even when the ephemeral Observer pane is already gone.
		}
	}
	return {
		content: [{ type: "text", text: `Learning ${learning.learningId} recorded for the Conclave.` }],
		details: learning,
	};
}

function listLearningRecords(projectPath: string, workId: string, projectTrusted = false): LearningRecord[] {
	return listLearningRecordsFromArchive(projectPath, projectTrusted).filter((learning) => learning.workId === workId);
}

function readObserverBinding(context: ExtensionContext): ObserverBinding | undefined {
	let binding: ObserverBinding | undefined;
	for (const entry of context.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === KhalaEntryType.observer) {
			const data = entry.data as {
				workId?: unknown;
				executionId?: unknown;
				observerName?: unknown;
				projectPath?: unknown;
			};
			if (
				typeof data.workId === "string" &&
				typeof data.executionId === "string" &&
				typeof data.observerName === "string" &&
				typeof data.projectPath === "string"
			) {
				binding = {
					workId: data.workId,
					executionId: data.executionId,
					observerName: data.observerName,
					projectPath: data.projectPath,
				};
				break;
			}
		}
	}
	return binding;
}

export { listLearningRecords, registerKhalaLearning };
