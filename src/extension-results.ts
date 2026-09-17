import { type AgentToolUpdateCallback, keyHint, type Theme, truncateHead } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import type { JsonObject, JsonValue, WorkView } from "./model.js";
import type { OperationContext } from "./ports.js";
import { ApplicationError } from "./service.js";

const MODEL_VISIBLE_SIGNAL_KINDS = ["progress", "blocked", "ready"] as const;
const MISSING_EXECUTABLE_MARKERS = [
	"command not found",
	"is not recognized as an internal or external command",
	"cannot find the path specified",
] as const;
export type ToolResult = { content: [{ type: "text"; text: string }]; details: JsonValue };

export function toolResult(value: JsonValue): ToolResult {
	return {
		content: [{ type: "text", text: boundedToolText(summarizeToolValue(value), value) }],
		details: value,
	};
}

export function archiveToolResult(value: JsonValue): ToolResult {
	const recordCount = isArchiveSummary(value) ? value["items"].length : 0;
	const text = `Archive records: ${recordCount}\n${JSON.stringify(value)}`;
	return {
		content: [{ type: "text", text: boundedToolText(text, value) }],
		details: value,
	};
}

export function renderArchiveToolResult(
	result: ArchiveRenderResult,
	expanded: boolean,
	isPartial: boolean,
	theme: Theme,
): Component {
	if (isPartial) return new Text(theme.fg("warning", "Reading Archive..."), 0, 0);
	// SAFETY: Pi passes the JSON-serializable details returned by archiveToolResult.
	const details = result.details as JsonValue | undefined;
	const headline = archiveToolHeadline(details);
	return expanded ? expandedArchiveToolResult(result, headline, theme) : collapsedArchiveToolResult(headline, theme);
}

type ArchiveRenderResult = Readonly<{
	content: readonly Readonly<{ type: string; text?: string }>[];
	details?: unknown;
}>;

function collapsedArchiveToolResult(headline: string, theme: Theme): Component {
	return new Text(theme.fg("success", `${headline} ${keyHint("app.tools.expand", "to expand")}`), 0, 0);
}

function expandedArchiveToolResult(result: ArchiveRenderResult, headline: string, theme: Theme): Component {
	const content = result.content[0];
	const text = content?.type === "text" ? (content.text ?? headline) : headline;
	return new Text(theme.fg("toolOutput", text), 0, 0);
}

function archiveToolHeadline(value: JsonValue | undefined): string {
	if (!isArchiveSummary(value)) return "Archive read complete.";
	return `Archive: ${value["items"].length} recent summaries through sequence ${value["asOfSequence"]}.`;
}

// Pi marks an execute() failure only when the tool throws; an isError field on a returned value is ignored.
export function toolError(error: JsonObject): never {
	throw new Error(boundedToolText(summarizeToolError(error), error));
}

export function toolOperation(
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<JsonValue> | undefined,
): OperationContext {
	return {
		signal,
		onUpdate:
			onUpdate === undefined
				? undefined
				: (message) =>
						onUpdate({
							content: [{ type: "text", text: message }],
							details: { progress: message },
						}),
	};
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw new Error("Khala operation was cancelled.");
}
function boundedToolText(text: string, value: JsonValue): string {
	const truncated = truncateHead(text, { maxBytes: 48_000, maxLines: 1_800 });
	if (!truncated.truncated) return truncated.content;
	return `${truncated.content}\n[Output truncated. ${continuationHint(value)}]`;
}

function continuationHint(value: JsonValue): string {
	const cursor = isJsonObject(value) && isTextValue(value["nextCursor"]) ? value["nextCursor"] : undefined;
	return cursor === undefined
		? "Use narrower filters or a targeted query to retrieve the remainder."
		: `Use nextCursor ${cursor} to continue.`;
}

export function formatCommandError(error: Error): string {
	if (!(error instanceof ApplicationError)) return error.message;
	const envelope = error.envelope;
	const evidence = envelope.evidenceRefs.length === 0 ? "" : `\nEvidence: ${envelope.evidenceRefs.join(", ")}`;
	return `Code: ${envelope.code}\n${envelope.summary}\nNext: ${envelope.remediation}${evidence}`;
}

export function toolErrorText(message: string): never {
	return toolError({
		code: "external-failure",
		summary: message,
		retryable: true,
		remediation: "Inspect the error and retry the operation when the underlying failure is resolved.",
		evidenceRefs: [],
	});
}

export function toolErrorFromError(error: Error, fallback: string): never {
	return error instanceof ApplicationError ? toolError(error.envelope) : toolErrorText(error.message || fallback);
}
function summarizeToolValue(value: JsonValue): string {
	const workSummary = summarizeWorkValue(value);
	if (workSummary !== undefined) return workSummary;
	const archiveSummary = summarizeArchiveValue(value);
	return archiveSummary ?? prettyJson(value);
}

function summarizeWorkValue(value: JsonValue): string | undefined {
	if (!isWorkSummary(value)) return undefined;
	return [
		`Work: ${value["workId"]}`,
		`State: ${value["state"]}`,
		`Next action: ${presentToolText(String(value["nextAction"]))}`,
		`Revision: ${value["revision"] ?? "unknown"}`,
		...modelVisibleWorkEvidence(value),
	].join("\n");
}

function summarizeArchiveValue(value: JsonValue): string | undefined {
	return isArchiveSummary(value) ? summarizeArchiveToolValue(value, []) : undefined;
}

export function summarizeArchiveToolValue(value: JsonValue, projects: readonly WorkView[]): string {
	if (!isArchiveSummary(value)) return prettyJson(value);
	const records = value["items"].filter(isJsonObject).map(archiveRecordSummary);
	const nextCursor = archiveNextCursor(value);
	return [
		...projects.map(archiveWorkProjection),
		`Archive records: ${records.length}`,
		`As of sequence: ${value["asOfSequence"]}`,
		...(nextCursor === undefined ? [] : [nextCursor]),
		...records,
	].join("\n");
}

function archiveWorkProjection(work: WorkView): string {
	const terms = work.mission?.assignment ?? work.terms;
	return [
		`Work ${work.workId}: revision ${work.revision}; state ${work.state}`,
		...archiveMissionState(work),
		...archiveMissionIdentity(work),
		`Terms title: ${boundedProjectionText(terms.title)}`,
		`Terms objective: ${boundedProjectionText(terms.objective)}`,
		`Terms scope: ${boundedProjectionText(terms.scope)}`,
		`Terms acceptance criteria:`,
		...boundedProjectionList(terms.acceptanceCriteria),
		`Terms constraints:`,
		...boundedProjectionList(terms.constraints),
		`Terms validation:`,
		...boundedProjectionList(terms.validation),
		`Terms allowed paths:`,
		...boundedProjectionList(terms.allowedPaths),
		...modelVisibleWorkEvidence(work),
	].join("\n");
}

function archiveMissionState(work: WorkView): readonly string[] {
	return work.missionState === undefined ? [] : [`Mission state: ${work.missionState}`];
}

function archiveMissionIdentity(work: WorkView): readonly string[] {
	const mission = work.mission;
	return mission === undefined ? [] : [`Mission ${mission.missionId}: mandate revision ${mission.mandateRevision}`];
}

function boundedProjectionText(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function boundedProjectionList(values: readonly string[]): readonly string[] {
	const text = values
		.slice(0, 20)
		.map(boundedProjectionText)
		.filter((value) => value.length > 0)
		.join("\n  - ")
		.slice(0, 3_996);
	return text.length === 0 ? ["  (none)"] : [`  - ${text}`];
}

function modelVisibleWorkEvidence(value: JsonObject): readonly string[] {
	return [...modelVisibleSignal(value["lastSignal"]), ...modelVisibleValidation(value["lastValidation"])];
}

function modelVisibleSignal(value: JsonValue | undefined): readonly string[] {
	if (!isJsonObject(value)) return [];
	const kind = MODEL_VISIBLE_SIGNAL_KINDS.find((candidate) => candidate === value["kind"]);
	if (kind === undefined) return [];
	const signalId = value["signalId"];
	if (!isTextValue(signalId)) return [];
	return [`Current Signal: ${kind}; signal ID: ${signalId}; evidence count: ${signalEvidenceCount(value["evidence"])}`];
}

function signalEvidenceCount(value: JsonValue | undefined): number {
	return Array.isArray(value) ? value.length : 0;
}

function modelVisibleValidation(value: JsonValue | undefined): readonly string[] {
	if (!isJsonObject(value) || !Array.isArray(value["results"])) return [];
	const failures = value["results"].filter(isJsonObject).filter((result) => result["passed"] === false);
	if (failures.length === 0) return [];
	const categories = [...new Set(failures.map(validationFailureCategory))];
	return [`Validation status: failed; failed count: ${failures.length}; categories: ${categories.join(", ")}`];
}

function validationFailureCategory(
	result: JsonObject,
): "required executable unavailable" | "declared validation command failed" {
	const output = result["output"];
	const missingExecutable =
		isTextValue(output) && MISSING_EXECUTABLE_MARKERS.some((marker) => output.toLowerCase().includes(marker));
	return missingExecutable ? "required executable unavailable" : "declared validation command failed";
}

function isWorkSummary(value: JsonValue): value is JsonObject {
	if (!isJsonObject(value)) return false;
	return ["workId", "state", "nextAction"].every((key) => isTextValue(value[key]));
}

function isArchiveSummary(
	value: JsonValue | undefined,
): value is JsonObject & { items: readonly JsonObject[]; asOfSequence: number } {
	if (!isJsonObject(value)) return false;
	return Array.isArray(value["items"]) && isIntegerValue(value["asOfSequence"]);
}

function archiveRecordSummary(record: JsonObject): string {
	const sequence = archiveSequence(record);
	const kind = archiveKind(record);
	const summary = archiveSummary(record);
	return `${sequence}${kind}${summary.length === 0 ? "" : `: ${summary}`}`;
}

function archiveSequence(record: JsonObject): string {
	return isIntegerValue(record["sequence"]) ? `#${record["sequence"]} ` : "";
}

function archiveKind(record: JsonObject): string {
	return isTextValue(record["kind"]) ? record["kind"] : "record";
}

function archiveSummary(record: JsonObject): string {
	return isTextValue(record["summary"]) ? record["summary"] : "";
}

function archiveNextCursor(value: JsonObject): string | undefined {
	if (!isTextValue(value["nextCursor"]) || value["nextCursor"].length === 0) return undefined;
	return `Next cursor: ${value["nextCursor"]}`;
}
export function summarizeToolError(error: JsonObject): string {
	return [errorSummary(error), errorRemediation(error), errorEvidence(error)].filter(isTextValue).join("\n");
}

function errorSummary(error: JsonObject): string {
	return isTextValue(error["summary"]) ? `Error: ${presentToolText(error["summary"])}` : "Khala action failed.";
}

function errorRemediation(error: JsonObject): string | undefined {
	return isTextValue(error["remediation"]) ? `Next step: ${presentToolText(error["remediation"])}` : undefined;
}

function errorEvidence(error: JsonObject): string | undefined {
	const refs = error["evidenceRefs"];
	if (!Array.isArray(refs) || refs.length === 0) return undefined;
	return `Evidence: ${refs.filter(isTextValue).join(", ")}`;
}

function presentToolText(value: string): string {
	return value
		.split(";")
		.map((part, index) => {
			const text = part.trim();
			return index === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
		})
		.filter((part) => part.length > 0)
		.join(". ");
}

function prettyJson(value: JsonValue): string {
	return JSON.stringify(value, null, 2) ?? String(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return Object.prototype.toString.call(value) === "[object Object]";
}

export function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function isIntegerValue(value: JsonValue | undefined): value is number {
	return value !== undefined && value === Number(value) && Number.isSafeInteger(Number(value));
}
