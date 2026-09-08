import type { ErrorEnvelope, JsonObject, JsonValue, RecordKind, RecordView } from "./model.js";
import {
	formatFieldRows,
	optionalPageSection,
	type PageSection,
	pageSection,
	presentEvidenceText,
} from "./tui-pages.js";

type MutableJsonObject = { [key: string]: JsonValue | undefined };

export function readObjectBoolean(object: JsonObject | undefined, key: string): boolean | undefined {
	const value = object?.[key];
	return value === true || value === false ? value : undefined;
}

export type RecordDetailFields = Readonly<{
	sections: readonly PageSection[];
	displayed: readonly string[];
	displayedEvidence?: readonly string[] | undefined;
}>;

export function recordTitle(record: RecordView): string {
	const kind = recordKindLabel(record);
	return record.kind === "signal"
		? kind === "signal"
			? `Signal ${record.sequence}`
			: `${capitalize(kind)} signal ${record.sequence}`
		: `${capitalize(kind)} ${record.sequence}`;
}
function signalSummarySection(record: RecordView, response: string | undefined): readonly PageSection[] {
	return record.summary.trim().length === 0 || response === record.summary
		? []
		: [pageSection([record.summary], "Summary")];
}

function signalResponseSection(record: RecordView, response: string | undefined): readonly PageSection[] {
	if (response !== undefined) return [pageSection([response], "Executor response")];
	return record.summary.trim().length === 0 ? [] : [pageSection([record.summary], "Executor response")];
}

function signalRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const response = readObjectText(payload, "summary");
	const evidence = readObjectTextList(payload, "evidence") ?? record.evidenceRefs;
	return {
		sections: [
			...signalSummarySection(record, response),
			...signalResponseSection(record, response),
			...optionalPageSection(evidence, "Evidence"),
		],
		displayed: ["kind", "summary", "evidence"],
		displayedEvidence: evidence,
	};
}

function errorFailureSection(record: RecordView, failure: string | undefined): readonly PageSection[] {
	if (failure === undefined) return [];
	if (failure.trim() === record.summary.trim()) return [];
	return [pageSection([failure], "Failure")];
}

function errorRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const learning = readPayloadObject(payload, "learning");
	const failure = readObjectText(learning, "failure");
	const remediation = readObjectText(payload, "remediation");
	return {
		sections: [
			...formatRecordSummarySections(record, payload, "Error"),
			...optionalPageSection(remediation === undefined ? [] : [remediation], "Recovery"),
			...errorFailureSection(record, failure),
		],
		displayed: ["summary", "remediation", "learning", "evidenceRefs"],
	};
}

function genericRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	return {
		sections: formatRecordSummarySections(record, payload),
		displayed: ["summary"],
	};
}

function validationRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const source =
		readObjectBoolean(payload, "sourceVerified") === true
			? "Committed source stayed unchanged during validation."
			: (readObjectText(payload, "sourceFailure") ??
				"Source verification was not recorded. Rerun validation before handoff.");
	return {
		sections: [...formatRecordSummarySections(record, payload), pageSection([source], "Source verification")],
		displayed: ["summary", "sourceVerified", "sourceFailure"],
	};
}

const RECORD_DETAIL_FORMATTERS = new Map<
	RecordKind,
	(record: RecordView, payload: JsonObject | undefined) => RecordDetailFields
>([
	["signal", signalRecordDetailFields],
	["error", errorRecordDetailFields],
	["oracle-review", formatOracleDetailFields],
	["validation", validationRecordDetailFields],
]);

export function recordDetailPayloadFields(record: RecordView): RecordDetailFields {
	const format = RECORD_DETAIL_FORMATTERS.get(record.kind) ?? genericRecordDetailFields;
	return format(record, readPayloadObjectValue(record.payload));
}
function formatRecordSummarySections(
	record: RecordView,
	payload: JsonObject | undefined,
	payloadHeading = "Payload summary",
): readonly PageSection[] {
	return [
		...(record.summary.trim().length === 0 ? [] : [pageSection([record.summary], "Summary")]),
		...payloadSummarySection(record, payload, payloadHeading),
	];
}

function payloadSummarySection(
	record: RecordView,
	payload: JsonObject | undefined,
	heading: string,
): readonly PageSection[] {
	const summary = readObjectText(payload, "summary");
	return summary === undefined || summary.trim() === record.summary.trim() ? [] : [pageSection([summary], heading)];
}
function oracleVerdictSection(verdict: string | undefined): readonly PageSection[] {
	return verdict === undefined ? [] : [pageSection(formatFieldRows([["Verdict", verdict]]))];
}

function oracleFindingsSection(findings: readonly JsonObject[]): readonly PageSection[] {
	return findings.length === 0 ? [] : [pageSection(formatFindings(findings), "Findings")];
}

function oracleValidationSection(gaps: readonly string[]): readonly PageSection[] {
	return gaps.length === 0
		? []
		: [
				pageSection(
					gaps.map((gap, index) => `${index + 1}  ${gap}`),
					"Validation gaps",
				),
			];
}

function oracleOutputSection(output: string | undefined): readonly PageSection[] {
	return output === undefined ? [] : [pageSection([output], "Model response")];
}

function oracleDurationSection(duration: number | undefined): readonly PageSection[] {
	return duration === undefined ? [] : [pageSection(formatFieldRows([["Duration", `${duration} ms`]]))];
}

function formatOracleDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const findings = readPayloadObjects(payload, "findings");
	const gaps = readObjectTextList(payload, "validationGaps") ?? [];
	const output = readObjectText(payload, "output");
	const duration = readObjectNumber(payload, "durationMs");
	const verdict = readObjectText(payload, "verdict");
	return {
		sections: [
			...formatRecordSummarySections(record, payload),
			...oracleVerdictSection(verdict),
			...oracleFindingsSection(findings),
			...oracleValidationSection(gaps),
			...oracleOutputSection(output),
			...oracleDurationSection(duration),
		],
		displayed: ["summary", "verdict", "findings", "validationGaps", "output", "durationMs"],
	};
}

function formatFindings(findings: readonly JsonObject[]): readonly string[] {
	return findings.flatMap((finding, index) => {
		const severity = readObjectText(finding, "severity");
		const summary = readObjectText(finding, "summary");
		const evidence = readObjectTextList(finding, "evidence") ?? [];
		return [
			`${index + 1}${severity === undefined ? "" : `  ${severity}`}${summary === undefined ? "" : `  ${summary}`}`,
			...evidence.map((item) => `    ${item}`),
		];
	});
}

export function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function formatStructuredFields(payload: JsonValue, displayed: readonly string[]): readonly string[] {
	const remaining = omitPayloadFields(payload, displayed);
	if (remaining === undefined) return [];
	const serialized = JSON.stringify(remaining, null, 2);
	return serialized === "{}" || serialized === "[]" ? [] : serialized.split("\n");
}
function remainingPayloadFields(payload: JsonObject, excluded: ReadonlySet<string>) {
	const remaining: MutableJsonObject = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value !== undefined && !excluded.has(key)) remaining[key] = value;
	}
	return remaining;
}

function omitPayloadFields(payload: JsonValue, displayed: readonly string[]): JsonValue | undefined {
	if (!isJsonObject(payload)) return payload;
	const remaining = remainingPayloadFields(payload, new Set(displayed));
	return Object.keys(remaining).length === 0 ? undefined : remaining;
}
export function recordKindLabel(record: RecordView): string {
	const signalKind = record.kind === "signal" ? readPayloadText(record.payload, "kind") : undefined;
	if (signalKind !== undefined && SIGNAL_KINDS.some((kind) => kind === signalKind)) return signalKind;
	const labels = {
		submission: "submission",
		assessment: "assessment",
		learning: "learning",
		mission: "mission",
		"mission-change": "mission change",
		execution: "execution",
		validation: "validation",
		signal: "signal",
		"review-request": "review request",
		observation: "observation",
		delivery: "delivery",
		verdict: "verdict",
		"oracle-review": "oracle review",
		outcome: "outcome",
		error: "error",
		"work-amended": "work amended",
		invocation: "invocation",
	} satisfies Record<RecordKind, string>;
	return labels[record.kind];
}

const SIGNAL_KINDS: readonly string[] = ["ready", "progress", "blocked"];

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function readPayloadObjectValue(payload: JsonValue): JsonObject | undefined {
	return isJsonObject(payload) ? payload : undefined;
}

function readPayloadObject(payload: JsonObject | undefined, key: string): JsonObject | undefined {
	const value = payload?.[key];
	return isJsonObject(value) ? value : undefined;
}

function readObjectText(object: JsonObject | undefined, key: string): string | undefined {
	const value = object?.[key];
	return isTextValue(value) ? value : undefined;
}

function readObjectTextList(object: JsonObject | undefined, key: string): readonly string[] | undefined {
	const value = object?.[key];
	return Array.isArray(value) && value.every(isTextValue) ? value : undefined;
}

function readPayloadObjects(object: JsonObject | undefined, key: string): readonly JsonObject[] {
	const value = object?.[key];
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}
function readObjectNumber(object: JsonObject | undefined, key: string): number | undefined {
	return finiteNumber(object?.[key]);
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
	const number = Number(value);
	return value !== undefined && value === number && Number.isFinite(number) ? number : undefined;
}

export function readPayloadText(payload: JsonValue, key: string): string | undefined {
	return readObjectText(readPayloadObjectValue(payload), key);
}

export function readPayloadBoolean(payload: JsonValue, key: string): boolean | undefined {
	return readObjectBoolean(readPayloadObjectValue(payload), key);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

export function formatRecordedAt(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace("T", " ");
}
function errorMetadata(error: ErrorEnvelope): readonly (readonly [string, string])[] {
	const metadata: Array<readonly [string, string]> = [
		["code", error.code],
		["retryable", error.retryable ? "yes" : "no"],
	];
	if (error.evidenceRefs.length > 0) metadata.push(["evidence", error.evidenceRefs.join(", ")]);
	return metadata;
}

function nonBlankErrorLine(value: string): readonly string[] {
	return value.trim().length === 0 ? [] : [presentEvidenceText(value)];
}

function learningErrorLine(error: ErrorEnvelope): readonly string[] {
	const specificity = error.learning?.missionSpecificity;
	return specificity === undefined ? [] : [`learning: ${presentEvidenceText(specificity)}`];
}

function errorNextStep(error: ErrorEnvelope): readonly string[] {
	return [...nonBlankErrorLine(error.remediation), ...learningErrorLine(error)];
}

export function formatErrorSections(error: ErrorEnvelope | undefined): readonly PageSection[] {
	if (error === undefined) return [];
	return [
		...optionalPageSection(nonBlankErrorLine(error.summary), "Error"),
		pageSection(formatFieldRows(errorMetadata(error))),
		...optionalPageSection(errorNextStep(error), "Next step"),
	];
}
