import { resolve } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { listArchiveRecords } from "./khala-archive.js";
import { KhalaEntryType } from "./khala-entry-types.js";
import type { KhalaArchiveRecord } from "./khala-model.js";
import { KhalaRole, type KhalaRoleValue } from "./khala-role.js";

const ARCHIVE_READ_PARAMETERS = Type.Object({
	workId: Type.Optional(Type.String()),
	executionId: Type.Optional(Type.String()),
});
type ArchiveReadParameters = Static<typeof ARCHIVE_READ_PARAMETERS>;
type ArchiveReadDetails = Readonly<{ records: readonly KhalaArchiveRecord[] }>;
type SessionRoleReader = (context: ExtensionContext) => KhalaRoleValue | null;
type ExecutorBinding = Readonly<{ executionId: string; projectPath: string; workId: string }>;

function registerKhalaArchiveRead(pi: ExtensionAPI, readSessionRole: SessionRoleReader): void {
	pi.registerTool(createArchiveReadTool(pi, readSessionRole));
}

function createArchiveReadTool(
	pi: ExtensionAPI,
	readSessionRole: SessionRoleReader,
): ToolDefinition<typeof ARCHIVE_READ_PARAMETERS, ArchiveReadDetails> {
	return {
		name: "khala_read_archive",
		label: "Read Khala Archive",
		description:
			"Read authoritative Khala records visible to the current role; the UI renders a compact summary and expandable record list.",
		promptSnippet: "Read authoritative Khala Archive records with compact UI output",
		parameters: ARCHIVE_READ_PARAMETERS,
		// biome-ignore lint/complexity/useMaxParams: Pi defines the tool callback with five positional parameters.
		execute: (_toolCallId, params, _signal, _onUpdate, context) =>
			Promise.resolve(executeArchiveRead(pi, readSessionRole, params, context)),
		renderCall: (args, theme) => renderArchiveReadCall(args, theme),
		renderResult: (result, options, theme) => renderArchiveReadToolResult(result, options, theme),
	};
}

function executeArchiveRead(
	pi: ExtensionAPI,
	readSessionRole: SessionRoleReader,
	params: ArchiveReadParameters,
	context: ExtensionContext,
): AgentToolResult<ArchiveReadDetails> {
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
		isVisibleArchiveRecord(record, { params, projectPath, boundWorkId, boundExecutionId }),
	);
	return {
		content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
		details: { records },
	};
}

function renderArchiveReadCall(args: ArchiveReadParameters, theme: Theme): Component {
	const filters: string[] = [];
	if (args.workId !== undefined) {
		filters.push(`work=${args.workId}`);
	}
	if (args.executionId !== undefined) {
		filters.push(`execution=${args.executionId}`);
	}
	let suffix = "";
	if (filters.length > 0) {
		suffix = ` ${theme.fg("muted", filters.join(" "))}`;
	}
	return new Text(theme.fg("toolTitle", theme.bold("khala_read_archive")) + suffix, 0, 0);
}

function renderArchiveReadToolResult(
	result: AgentToolResult<ArchiveReadDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Component {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Reading Khala Archive..."), 0, 0);
	}
	const { details, content } = result;
	if (details === undefined) {
		const [text] = content;
		let fallback = "";
		if (text?.type === "text") {
			fallback = text.text;
		}
		return new Text(fallback, 0, 0);
	}
	return new Text(renderArchiveReadResult(details.records, options.expanded, theme), 0, 0);
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

const COMPACT_ARCHIVE_RECORD_LIMIT = 200;
const ARCHIVE_RECORD_PREVIEW_LIMIT = 5;
const SHORT_ARCHIVE_ID_LENGTH = 12;
const SHORT_ARCHIVE_ID_HEAD_LENGTH = 8;
const SHORT_ARCHIVE_ID_TAIL_LENGTH = 3;
const ARCHIVE_TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const ARCHIVE_TIMESTAMP_SUFFIX_PATTERN = /\.\d{3}Z$/;
const ARCHIVE_RECORD_ID_FIELDS = [
	"signalId",
	"mandateId",
	"missionId",
	"executionId",
	"pullRequestId",
	"outcomeId",
	"deliveryId",
	"learningId",
	"counselId",
] as const;

type ArchivePayload = Record<string, unknown>;

function renderArchiveReadResult(records: readonly KhalaArchiveRecord[], expanded: boolean, theme: Theme): string {
	if (records.length === 0) {
		return theme.fg("dim", "Khala Archive: no visible records");
	}

	const workIds = new Set(records.map((record) => record.workId));
	const typeCounts = countArchiveValues(records.map((record) => record.type));
	const lines = [
		theme.fg("muted", `Khala Archive: ${records.length} record(s) · ${workIds.size} Work(s)`),
		theme.fg("dim", `Types: ${formatArchiveCounts(typeCounts)}`),
	];

	if (expanded) {
		lines.push(theme.fg("dim", "Records:"));
		const compactRecords = records.slice(-COMPACT_ARCHIVE_RECORD_LIMIT);
		if (records.length > compactRecords.length) {
			lines.push(theme.fg("dim", `… ${records.length - compactRecords.length} earlier record(s) omitted`));
		}
		lines.push(...compactRecords.map((record) => theme.fg("muted", formatCompactArchiveRecord(record))));
		return lines.join("\n");
	}

	lines.push(theme.fg("dim", "Latest:"));
	lines.push(
		...records
			.slice(-ARCHIVE_RECORD_PREVIEW_LIMIT)
			.map((record) => theme.fg("muted", formatCompactArchiveRecord(record))),
	);
	lines.push(theme.fg("dim", `… ${keyHint("app.tools.expand", "to expand")}`));
	return lines.join("\n");
}

function formatCompactArchiveRecord(record: KhalaArchiveRecord): string {
	const { payload: rawPayload } = record;
	let payload: ArchivePayload | undefined;
	if (isArchivePayload(rawPayload)) {
		payload = rawPayload;
	}
	const state = readFirstString(payload, ["status", "decision", "kind"]);
	const entityId = shortOptionalArchiveId(readFirstString(payload, ARCHIVE_RECORD_ID_FIELDS));
	const execution = shortOptionalArchiveId(record.executionId ?? readFirstString(payload, ["executionId"]));
	const timestamp = record.recordedAt
		.replace(ARCHIVE_TIMESTAMP_PREFIX_PATTERN, "")
		.replace(ARCHIVE_TIMESTAMP_SUFFIX_PATTERN, "Z");
	const fields = [timestamp, record.type, state, `work=${shortArchiveId(record.workId)}`, entityId, execution];
	return fields.filter((field): field is string => field !== undefined).join(" ");
}

function isArchivePayload(value: unknown): value is ArchivePayload {
	return typeof value === "object" && value !== null;
}

function readFirstString(payload: ArchivePayload | undefined, fields: readonly string[]): string | undefined {
	let result: string | undefined;
	if (payload !== undefined) {
		for (const field of fields) {
			const value = payload[field];
			if (typeof value === "string" && value.length > 0) {
				result = value;
				break;
			}
		}
	}
	return result;
}

function shortArchiveId(value: string): string {
	if (value.length <= SHORT_ARCHIVE_ID_LENGTH) {
		return value;
	}
	return `${value.slice(0, SHORT_ARCHIVE_ID_HEAD_LENGTH)}…${value.slice(-SHORT_ARCHIVE_ID_TAIL_LENGTH)}`;
}

function shortOptionalArchiveId(value: string | undefined): string | undefined {
	if (value === undefined) {
		return;
	}
	return shortArchiveId(value);
}

function countArchiveValues(values: readonly string[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return counts;
}

function formatArchiveCounts(counts: ReadonlyMap<string, number>): string {
	return [...counts.entries()].map(([value, count]) => `${value}=${count}`).join(" · ");
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
