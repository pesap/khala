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
type ExecutorBinding = Readonly<{ executionId: string; projectPath: string }>;

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
			if (role === KhalaRole.executor) {
				const binding = readExecutorBinding(context);
				const configuredProjectPath = pi.getFlag("khala-project-path");
				if (
					binding === undefined ||
					params.executionId !== binding.executionId ||
					typeof configuredProjectPath !== "string" ||
					resolve(configuredProjectPath) !== resolve(binding.projectPath)
				) {
					throw new Error("An Executor may only read its bound execution from the Archive.");
				}
				projectPath = resolve(binding.projectPath);
				boundExecutionId = binding.executionId;
			}
			if (role === null && params.workId === undefined) {
				throw new Error("A User Session must specify a workId when reading the Archive.");
			}
			const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
			const records = listArchiveRecords(projectPath, projectTrusted).filter((record) => {
				if (
					boundExecutionId !== undefined &&
					(resolve(record.projectPath) !== projectPath || record.executionId !== boundExecutionId)
				) {
					return false;
				}
				if (params.workId !== undefined && record.workId !== params.workId) {
					return false;
				}
				if (params.executionId !== undefined && record.executionId !== params.executionId) {
					return false;
				}
				return true;
			});
			return Promise.resolve({
				content: [{ type: "text" as const, text: JSON.stringify(records, null, 2) }],
				details: { records },
			});
		},
	});
}

function readExecutorBinding(context: ExtensionContext): ExecutorBinding | undefined {
	let binding: ExecutorBinding | undefined;
	for (const entry of [...context.sessionManager.getBranch()].reverse()) {
		if (entry.type === "custom" && entry.customType === KhalaEntryType.executor) {
			const data = entry.data as { executionId?: unknown; projectPath?: unknown };
			if (typeof data.executionId === "string" && typeof data.projectPath === "string" && data.projectPath.length > 0) {
				binding = { executionId: data.executionId, projectPath: data.projectPath };
				break;
			}
		}
	}
	return binding;
}

export { registerKhalaArchiveRead };
