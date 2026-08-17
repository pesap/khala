// biome-ignore-all lint/style/noExcessiveLinesPerFile: Role-specific schemas share one Archive authorization and rendering boundary.
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
import { projectDiagnosticValue, serializedByteLength } from "./khala-payload-projection.js";
import { isUserSessionRole, KhalaRole, type KhalaRoleValue } from "./khala-role.js";

const ARCHIVE_READ_RESULT_BYTE_LIMIT = 40_000;
const DEFAULT_ARCHIVE_PAGE_LIMIT = 25;
const MAX_ARCHIVE_PAGE_LIMIT = 100;
const ARCHIVE_PROJECTION_OPTIONS = {
	maxArrayItems: 8,
	maxDepth: 5,
	maxNodes: 48,
	maxObjectFields: 32,
	maxStringBytes: 320,
} as const;
const ARCHIVE_READ_PARAMETERS = Type.Object({
	workId: Type.Optional(Type.String({ description: "Required in User sessions; optional for project-scoped roles." })),
	executionId: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String({ description: "Continue after this visible Archive record ID." })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_ARCHIVE_PAGE_LIMIT, description: "Maximum records in this page." }),
	),
});
const USER_ARCHIVE_READ_PARAMETERS = Type.Object({
	workId: Type.String({ description: "Work whose authorized Archive records the User needs to inspect." }),
	executionId: Type.Optional(Type.String()),
	cursor: Type.Optional(Type.String({ description: "Continue after this visible Archive record ID." })),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_ARCHIVE_PAGE_LIMIT, description: "Maximum records in this page." }),
	),
});
type ArchiveReadParameterSchema = typeof ARCHIVE_READ_PARAMETERS | typeof USER_ARCHIVE_READ_PARAMETERS;
type ArchiveReadParameters = Static<typeof ARCHIVE_READ_PARAMETERS>;
type ArchiveRecordProjection = Readonly<{
	recordId: string;
	schemaVersion?: KhalaArchiveRecord["schemaVersion"];
	type: KhalaArchiveRecord["type"];
	workId: string;
	executionId?: string;
	recordedAt: string;
	payload: unknown;
	projection: ReturnType<typeof projectDiagnosticValue>["truncation"];
}>;
type ArchiveRecordSummary = Readonly<{
	recordId: string;
	type: KhalaArchiveRecord["type"];
	workId: string;
	executionId?: string;
	recordedAt: string;
	state?: string;
}>;
type ArchiveReadPage = Readonly<{
	order: "archive-append";
	cursor?: string;
	nextCursor?: string;
	returned: number;
	totalVisible: number;
	remaining: number;
	hasMore: boolean;
	truncated: boolean;
	truncationReason?: "limit" | "byte-budget";
	projectedRecordsTruncated: number;
	byteBudget: number;
}>;
type ArchiveReadDetails = Readonly<{
	page: ArchiveReadPage;
	summaries: readonly ArchiveRecordSummary[];
}>;
type ArchiveReadMetadataInput = Readonly<{
	totalVisible: number;
	startIndex: number;
	projections: readonly ArchiveRecordProjection[];
	cursor: string | undefined;
	reason: "limit" | "byte-budget";
}>;
type SessionRoleReader = (context: ExtensionContext) => KhalaRoleValue | null;
type ExecutorBinding = Readonly<{ executionId: string; projectPath: string; workId: string }>;

function registerKhalaArchiveRead(pi: ExtensionAPI, readSessionRole: SessionRoleReader): void {
	pi.registerTool(createArchiveReadTool(pi, readSessionRole, ARCHIVE_READ_PARAMETERS));
}

function registerRoleKhalaArchiveRead(
	pi: ExtensionAPI,
	readSessionRole: SessionRoleReader,
	role: KhalaRoleValue | null,
): void {
	let parameters: ArchiveReadParameterSchema = ARCHIVE_READ_PARAMETERS;
	if (isUserSessionRole(role)) {
		parameters = USER_ARCHIVE_READ_PARAMETERS;
	}
	pi.registerTool(createArchiveReadTool(pi, readSessionRole, parameters));
}

function createArchiveReadTool(
	pi: ExtensionAPI,
	readSessionRole: SessionRoleReader,
	parameters: ArchiveReadParameterSchema,
): ToolDefinition<ArchiveReadParameterSchema, ArchiveReadDetails> {
	return {
		name: "khala_read_archive",
		label: "Read Khala Archive",
		description:
			"Read one append-ordered page of role-visible Khala Archive record projections. Continue with nextCursor when hasMore is true.",
		promptSnippet: "Read a bounded page of authoritative Khala Archive record projections",
		parameters,
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
	if (isUserSessionRole(role) && params.workId === undefined) {
		throw new Error("A User must specify a workId when reading the Archive.");
	}
	const limit = params.limit ?? DEFAULT_ARCHIVE_PAGE_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARCHIVE_PAGE_LIMIT) {
		throw new Error(`Archive page limit must be an integer from 1 to ${MAX_ARCHIVE_PAGE_LIMIT}.`);
	}
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const records = listArchiveRecords(projectPath, projectTrusted).filter((record) =>
		isVisibleArchiveRecord(record, { params, projectPath, boundWorkId, boundExecutionId }),
	);
	let startIndex = 0;
	if (params.cursor !== undefined) {
		const cursorIndex = records.findIndex((record) => record.recordId === params.cursor);
		if (cursorIndex < 0) {
			throw new Error("Archive cursor is not present in the role-visible filtered record set.");
		}
		startIndex = cursorIndex + 1;
	}
	return createArchiveReadPage(records, startIndex, limit, params.cursor);
}

function renderArchiveReadCall(args: ArchiveReadParameters, theme: Theme): Component {
	const filters: string[] = [];
	if (args.workId !== undefined) {
		filters.push(`work=${args.workId}`);
	}
	if (args.executionId !== undefined) {
		filters.push(`execution=${args.executionId}`);
	}
	if (args.cursor !== undefined) {
		filters.push(`after=${shortArchiveId(args.cursor)}`);
	}
	if (args.limit !== undefined) {
		filters.push(`limit=${args.limit}`);
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
	return new Text(renderArchiveReadResult(details, options.expanded, theme), 0, 0);
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

const ARCHIVE_RECORD_PREVIEW_LIMIT = 5;
const SHORT_ARCHIVE_ID_LENGTH = 12;
const SHORT_ARCHIVE_ID_HEAD_LENGTH = 8;
const SHORT_ARCHIVE_ID_TAIL_LENGTH = 3;
const ARCHIVE_TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const ARCHIVE_TIMESTAMP_SUFFIX_PATTERN = /\.\d{3}Z$/;

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Page fitting keeps exact serialized-result accounting in one loop.
function createArchiveReadPage(
	records: readonly KhalaArchiveRecord[],
	startIndex: number,
	limit: number,
	cursor: string | undefined,
): AgentToolResult<ArchiveReadDetails> {
	let projections: ArchiveRecordProjection[] = [];
	let summaries: ArchiveRecordSummary[] = [];
	let stoppedByByteBudget = false;
	const pageEnd = Math.min(records.length, startIndex + limit);
	for (let index = startIndex; index < pageEnd; index += 1) {
		const record = records[index];
		if (record === undefined) {
			break;
		}
		let projection = projectArchiveRecord(record);
		let summary = summarizeArchiveRecord(projection);
		let tentativeProjections = [...projections, projection];
		let tentativeSummaries = [...summaries, summary];
		let tentative = composeArchiveReadResult(
			tentativeProjections,
			tentativeSummaries,
			createArchiveReadMetadata({
				totalVisible: records.length,
				startIndex,
				projections: tentativeProjections,
				cursor,
				reason: "byte-budget",
			}),
		);
		if (serializedByteLength(tentative) > ARCHIVE_READ_RESULT_BYTE_LIMIT && projections.length === 0) {
			projection = omitArchivePayload(projection);
			summary = summarizeArchiveRecord(projection);
			tentativeProjections = [projection];
			tentativeSummaries = [summary];
			tentative = composeArchiveReadResult(
				tentativeProjections,
				tentativeSummaries,
				createArchiveReadMetadata({
					totalVisible: records.length,
					startIndex,
					projections: tentativeProjections,
					cursor,
					reason: "byte-budget",
				}),
			);
		}
		if (serializedByteLength(tentative) > ARCHIVE_READ_RESULT_BYTE_LIMIT) {
			stoppedByByteBudget = true;
			break;
		}
		projections = tentativeProjections;
		summaries = tentativeSummaries;
	}
	let reason: ArchiveReadMetadataInput["reason"] = "limit";
	if (stoppedByByteBudget) {
		reason = "byte-budget";
	}
	const result = composeArchiveReadResult(
		projections,
		summaries,
		createArchiveReadMetadata({ totalVisible: records.length, startIndex, projections, cursor, reason }),
	);
	if (serializedByteLength(result) > ARCHIVE_READ_RESULT_BYTE_LIMIT) {
		throw new Error("Archive page identifying metadata exceeds the serialized result byte budget.");
	}
	return result;
}

function projectArchiveRecord(record: KhalaArchiveRecord): ArchiveRecordProjection {
	const projected = projectDiagnosticValue(record.payload, ARCHIVE_PROJECTION_OPTIONS);
	let result: ArchiveRecordProjection = {
		recordId: record.recordId,
		type: record.type,
		workId: record.workId,
		recordedAt: record.recordedAt,
		payload: projected.value,
		projection: projected.truncation,
	};
	if (record.schemaVersion !== undefined) {
		result = { ...result, schemaVersion: record.schemaVersion };
	}
	if (record.executionId !== undefined) {
		result = { ...result, executionId: record.executionId };
	}
	return result;
}

function omitArchivePayload(record: ArchiveRecordProjection): ArchiveRecordProjection {
	return {
		...record,
		payload: {},
		projection: {
			...record.projection,
			truncated: true,
			omittedValues: record.projection.omittedValues + 1,
		},
	};
}

function summarizeArchiveRecord(record: ArchiveRecordProjection): ArchiveRecordSummary {
	const state = readProjectedArchiveState(record.payload);
	let result: ArchiveRecordSummary = {
		recordId: record.recordId,
		type: record.type,
		workId: record.workId,
		recordedAt: record.recordedAt,
	};
	if (record.executionId !== undefined) {
		result = { ...result, executionId: record.executionId };
	}
	if (state !== undefined) {
		result = { ...result, state };
	}
	return result;
}

function createArchiveReadMetadata(input: ArchiveReadMetadataInput): ArchiveReadPage {
	const remaining = Math.max(0, input.totalVisible - input.startIndex - input.projections.length);
	const hasMore = remaining > 0;
	let nextCursor: string | undefined;
	if (hasMore) {
		nextCursor = input.projections.at(-1)?.recordId;
	}
	const projectedRecordsTruncated = input.projections.filter((record) => record.projection.truncated).length;
	let result: ArchiveReadPage = {
		order: "archive-append",
		returned: input.projections.length,
		totalVisible: input.totalVisible,
		remaining,
		hasMore,
		truncated: hasMore || projectedRecordsTruncated > 0,
		projectedRecordsTruncated,
		byteBudget: ARCHIVE_READ_RESULT_BYTE_LIMIT,
	};
	if (input.cursor !== undefined) {
		result = { ...result, cursor: input.cursor };
	}
	if (nextCursor !== undefined) {
		result = { ...result, nextCursor };
	}
	if (hasMore) {
		result = { ...result, truncationReason: input.reason };
	}
	return result;
}

function composeArchiveReadResult(
	records: readonly ArchiveRecordProjection[],
	summaries: readonly ArchiveRecordSummary[],
	page: ArchiveReadPage,
): AgentToolResult<ArchiveReadDetails> {
	return {
		content: [{ type: "text", text: JSON.stringify({ page, records }) }],
		details: { page, summaries },
	};
}

function renderArchiveReadResult(details: ArchiveReadDetails, expanded: boolean, theme: Theme): string {
	const { page, summaries } = details;
	if (page.totalVisible === 0) {
		return theme.fg("dim", "Khala Archive: no visible records");
	}
	const typeCounts = countArchiveValues(summaries.map((record) => record.type));
	const lines = [
		theme.fg("muted", `Khala Archive: ${page.returned} of ${page.totalVisible} record(s)`),
		theme.fg("dim", `Page types: ${formatArchiveCounts(typeCounts)}`),
	];
	if (page.hasMore) {
		lines.push(theme.fg("dim", `Continuation: nextCursor=${shortArchiveId(page.nextCursor as string)}`));
	}
	if (expanded) {
		lines.push(theme.fg("dim", "Records:"));
		lines.push(...summaries.map((record) => theme.fg("muted", formatCompactArchiveRecord(record))));
		return lines.join("\n");
	}
	lines.push(theme.fg("dim", "Latest in page:"));
	lines.push(
		...summaries
			.slice(-ARCHIVE_RECORD_PREVIEW_LIMIT)
			.map((record) => theme.fg("muted", formatCompactArchiveRecord(record))),
	);
	lines.push(theme.fg("dim", `… ${keyHint("app.tools.expand", "to expand")}`));
	return lines.join("\n");
}

function formatCompactArchiveRecord(record: ArchiveRecordSummary): string {
	const timestamp = record.recordedAt
		.replace(ARCHIVE_TIMESTAMP_PREFIX_PATTERN, "")
		.replace(ARCHIVE_TIMESTAMP_SUFFIX_PATTERN, "Z");
	const fields = [
		timestamp,
		record.type,
		record.state,
		`work=${shortArchiveId(record.workId)}`,
		shortOptionalArchiveId(record.recordId),
		shortOptionalArchiveId(record.executionId),
	];
	return fields.filter((field): field is string => field !== undefined).join(" ");
}

function readProjectedArchiveState(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) {
		return;
	}
	const payload = value as Record<string, unknown>;
	for (const field of ["status", "decision", "kind", "phase", "outcome"]) {
		const candidate = payload[field];
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	// biome-ignore lint/complexity/noUselessUndefined: Explicitly satisfy strict return analysis when no state exists.
	return undefined;
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

export { registerKhalaArchiveRead, registerRoleKhalaArchiveRead };
