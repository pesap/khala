import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listArchiveRecords } from "./khala-archive.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import { KhalaRole, type KhalaRoleValue } from "./khala-role.js";

const ARCHIVE_READ_PARAMETERS = Type.Object({
	workId: Type.Optional(Type.String()),
	executionId: Type.Optional(Type.String()),
});
type SessionRoleReader = (context: ExtensionContext) => KhalaRoleValue | null;
type ExecutorBinding = Readonly<{ executionId: string; projectPath: string; workId: string }>;

function registerKhalaArchiveRead(pi: ExtensionAPI, readSessionRole: SessionRoleReader): void {
	pi.registerTool({
		name: "khala_read_archive",
		label: "Read Khala Archive",
		description: "Read authoritative Khala records visible to the current role.",
		promptSnippet: "Read authoritative Khala Archive records",
		parameters: ARCHIVE_READ_PARAMETERS,
		// biome-ignore lint/complexity/useMaxParams: Pi defines the tool callback with five positional parameters.
		execute: (_toolCallId, params, _signal, _onUpdate, context) => {
			const role = readSessionRole(context);
			let projectPath = context.cwd;
			let boundExecutionId: string | undefined;
			let boundWorkId: string | undefined;
			if (role === KhalaRole.executor) {
				const binding = readExecutorBinding(context);
				const configuredProjectPath = pi.getFlag("khala-project-path");
				if (
					binding === undefined ||
					(params.executionId !== undefined && params.executionId !== binding.executionId) ||
					typeof configuredProjectPath !== "string" ||
					resolve(configuredProjectPath) !== resolve(binding.projectPath)
				) {
					throw new Error("An Executor may only read its bound execution from the Archive.");
				}
				projectPath = resolve(binding.projectPath);
				boundExecutionId = binding.executionId;
				boundWorkId = binding.workId;
			}
			if (role === null && params.workId === undefined) {
				throw new Error("A User Session must specify a workId when reading the Archive.");
			}
			const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
			const records = listArchiveRecords(projectPath, projectTrusted).filter((record) =>
				isVisibleArchiveRecord(record, {
					params,
					projectPath,
					boundWorkId,
					boundExecutionId,
				}),
			);
			return Promise.resolve({
				content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }],
				details: { records },
			});
		},
	});
}

function isVisibleArchiveRecord(
	record: ReturnType<typeof listArchiveRecords>[number],
	options: Readonly<{
		params: { workId?: string; executionId?: string };
		projectPath: string;
		boundWorkId: string | undefined;
		boundExecutionId: string | undefined;
	}>,
): boolean {
	const { params, projectPath, boundWorkId, boundExecutionId } = options;
	if (boundExecutionId !== undefined) {
		// Executors may inspect their Work assignment as well as records emitted by their execution.
		if (resolve(record.projectPath) !== projectPath || record.workId !== boundWorkId) {
			return false;
		}
		if (record.executionId !== undefined && record.executionId !== boundExecutionId) {
			return false;
		}
	}
	if (params.workId !== undefined && record.workId !== params.workId) {
		return false;
	}
	if (boundExecutionId === undefined && params.executionId !== undefined && record.executionId !== params.executionId) {
		return false;
	}
	return true;
}

function readExecutorBinding(context: ExtensionContext): ExecutorBinding | undefined {
	let binding: ExecutorBinding | undefined;
	for (const entry of [...context.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === KhalaEntryType.executor) {
			const data = entry.data as { executionId?: unknown; projectPath?: unknown; workId?: unknown };
			if (
				typeof data.executionId === "string" &&
				typeof data.projectPath === "string" &&
				typeof data.workId === "string" &&
				data.projectPath.length > 0
			) {
				binding = { executionId: data.executionId, projectPath: data.projectPath, workId: data.workId };
				break;
			}
		}
	}
	return binding;
}

export { registerKhalaArchiveRead };
