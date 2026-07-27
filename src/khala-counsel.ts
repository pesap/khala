import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { appendArchiveRecord } from "./khala-archive.js";
import { findArchiveRecords } from "./khala-archive-projections.js";
import type { CounselRecord, KhalaArchiveAppend } from "./khala-model.js";

const COUNSEL_PARAMETERS = Type.Object({
	workId: Type.String(),
	executionId: Type.Optional(Type.String()),
	sourceRecordIds: Type.Array(Type.String()),
	observations: Type.Array(Type.String()),
	recommendations: Type.Array(Type.String()),
	uncertainties: Type.Array(Type.String()),
});
type CounselInput = Static<typeof COUNSEL_PARAMETERS>;
type PreserverSessionCheck = (context: ExtensionContext) => boolean;

function registerKhalaCounsel(pi: ExtensionAPI, isPreserverSession: PreserverSessionCheck): void {
	pi.registerTool({
		name: "khala_counsel",
		label: "Record Khala Counsel",
		description: "Record source-backed advisory Counsel for the Conclave.",
		promptSnippet: "Record bounded Khala Counsel",
		parameters: COUNSEL_PARAMETERS,
		// biome-ignore lint/complexity/useMaxParams: Pi defines the tool callback with five positional parameters.
		execute: (_toolCallId, params, _signal, _onUpdate, context) => {
			if (!isPreserverSession(context)) {
				throw new Error("Only a Khala Preserver session may record Counsel.");
			}
			return recordCounsel(params, context);
		},
	});
}

function recordCounsel(params: CounselInput, context: ExtensionContext) {
	validateCounselSources(params, context);
	const sessionPath = context.sessionManager.getSessionFile();
	let counsel: CounselRecord = {
		...params,
		counselId: nanoid(),
		createdAt: new Date().toISOString(),
	};
	if (sessionPath !== undefined) {
		counsel = { ...counsel, authorSession: sessionPath };
	}
	let archiveInput: KhalaArchiveAppend = {
		schemaVersion: 2,
		type: "counsel",
		workId: counsel.workId,
		payload: counsel,
	};
	if (counsel.executionId !== undefined) {
		archiveInput = { ...archiveInput, executionId: counsel.executionId };
	}
	appendArchiveRecord(context.cwd, archiveInput, isProjectTrusted(context));
	return Promise.resolve({
		content: [{ type: "text" as const, text: `Counsel ${counsel.counselId} recorded.` }],
		details: counsel,
	});
}

function isProjectTrusted(context: ExtensionContext): boolean {
	return typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
}

function validateCounselSources(params: CounselInput, context: ExtensionContext): void {
	const sourceRecordIds = new Set(params.sourceRecordIds);
	if (sourceRecordIds.size === 0) {
		throw new Error("Counsel must cite at least one Archive record.");
	}
	const sourceRecords = findArchiveRecords(context.cwd, sourceRecordIds, isProjectTrusted(context));
	if (sourceRecords.length !== sourceRecordIds.size) {
		throw new Error("Counsel references an unknown Archive record.");
	}
	if (sourceRecords.some((record) => record.workId !== params.workId)) {
		throw new Error("Counsel sources must belong to the cited Work.");
	}
	if (params.executionId !== undefined && sourceRecords.some((record) => record.executionId !== params.executionId)) {
		throw new Error("Counsel sources must belong to the cited execution.");
	}
}

export { registerKhalaCounsel };
