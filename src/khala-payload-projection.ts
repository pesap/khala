// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Projection walks untrusted JSON-shaped evidence under one explicit budget.
import { Buffer } from "node:buffer";

const PROJECTION_OMITTED = "[omitted by projection budget]";
const PROJECTION_CYCLE = "[omitted circular value]";
const IDENTIFIER_KEY_PRIORITY = 0;
const STATE_KEY_PRIORITY = 1;
const TIMESTAMP_KEY_PRIORITY = 2;
const DIAGNOSTIC_KEY_PRIORITY = 3;
const OTHER_KEY_PRIORITY = 4;

type ProjectionOptions = Readonly<{
	maxArrayItems: number;
	maxDepth: number;
	maxNodes: number;
	maxObjectFields: number;
	maxStringBytes: number;
}>;

type ProjectionTruncation = Readonly<{
	truncated: boolean;
	truncatedStrings: number;
	omittedArrayItems: number;
	omittedObjectFields: number;
	omittedValues: number;
}>;

type DiagnosticProjection = Readonly<{
	value: unknown;
	truncation: ProjectionTruncation;
}>;

interface MutableProjectionState {
	nodes: number;
	truncatedStrings: number;
	omittedArrayItems: number;
	omittedObjectFields: number;
	omittedValues: number;
	seen: WeakSet<object>;
}

function serializedByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) {
		return value;
	}
	const ellipsis = "…";
	const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, "utf8"));
	let bytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > contentBudget) {
			break;
		}
		result += character;
		bytes += characterBytes;
	}
	return `${result}${ellipsis}`;
}

function projectDiagnosticValue(value: unknown, options: ProjectionOptions): DiagnosticProjection {
	const state: MutableProjectionState = {
		nodes: 0,
		truncatedStrings: 0,
		omittedArrayItems: 0,
		omittedObjectFields: 0,
		omittedValues: 0,
		seen: new WeakSet(),
	};
	const projected = projectValue(value, options, state, 0);
	const truncation: ProjectionTruncation = {
		truncated:
			state.truncatedStrings > 0 ||
			state.omittedArrayItems > 0 ||
			state.omittedObjectFields > 0 ||
			state.omittedValues > 0,
		truncatedStrings: state.truncatedStrings,
		omittedArrayItems: state.omittedArrayItems,
		omittedObjectFields: state.omittedObjectFields,
		omittedValues: state.omittedValues,
	};
	return { value: projected, truncation };
}

function projectValue(
	value: unknown,
	options: ProjectionOptions,
	state: MutableProjectionState,
	depth: number,
): unknown {
	if (state.nodes >= options.maxNodes) {
		state.omittedValues += 1;
		return PROJECTION_OMITTED;
	}
	state.nodes += 1;
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) {
			return value;
		}
		return String(value);
	}
	if (typeof value === "string") {
		const projected = truncateUtf8(value, options.maxStringBytes);
		if (projected !== value) {
			state.truncatedStrings += 1;
		}
		return projected;
	}
	if (typeof value !== "object") {
		state.omittedValues += 1;
		return PROJECTION_OMITTED;
	}
	if (state.seen.has(value)) {
		state.omittedValues += 1;
		return PROJECTION_CYCLE;
	}
	if (depth >= options.maxDepth) {
		state.omittedValues += 1;
		return PROJECTION_OMITTED;
	}
	state.seen.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		result = projectArray(value, options, state, depth);
	} else {
		result = projectObject(value as Record<string, unknown>, options, state, depth);
	}
	state.seen.delete(value);
	return result;
}

function projectArray(
	value: readonly unknown[],
	options: ProjectionOptions,
	state: MutableProjectionState,
	depth: number,
): readonly unknown[] {
	const included = Math.min(value.length, options.maxArrayItems);
	const result: unknown[] = [];
	for (let index = 0; index < included; index += 1) {
		if (state.nodes >= options.maxNodes) {
			state.omittedArrayItems += value.length - index;
			return result;
		}
		result.push(projectValue(value[index], options, state, depth + 1));
	}
	if (value.length > included) {
		state.omittedArrayItems += value.length - included;
	}
	return result;
}

function projectObject(
	value: Record<string, unknown>,
	options: ProjectionOptions,
	state: MutableProjectionState,
	depth: number,
): Readonly<Record<string, unknown>> {
	const keys = Object.keys(value).sort(compareProjectionKeys);
	const included = Math.min(keys.length, options.maxObjectFields);
	const result: Record<string, unknown> = {};
	for (let index = 0; index < included; index += 1) {
		if (state.nodes >= options.maxNodes) {
			state.omittedObjectFields += keys.length - index;
			return result;
		}
		const key = keys[index];
		if (key !== undefined) {
			result[key] = projectValue(value[key], options, state, depth + 1);
		}
	}
	if (keys.length > included) {
		state.omittedObjectFields += keys.length - included;
	}
	return result;
}

function compareProjectionKeys(left: string, right: string): number {
	const priorityDifference = projectionKeyPriority(left) - projectionKeyPriority(right);
	if (priorityDifference !== 0) {
		return priorityDifference;
	}
	return left.localeCompare(right);
}

function projectionKeyPriority(key: string): number {
	if (key === "id" || key.endsWith("Id") || key.endsWith("Ids")) {
		return IDENTIFIER_KEY_PRIORITY;
	}
	if (["type", "kind", "status", "state", "decision", "phase", "outcome", "relation", "mode"].includes(key)) {
		return STATE_KEY_PRIORITY;
	}
	if (key.endsWith("At") || key === "timestamp") {
		return TIMESTAMP_KEY_PRIORITY;
	}
	if (
		["summary", "reason", "failure", "error", "message", "evidence", "unresolvedGaps", "validationResults"].includes(
			key,
		)
	) {
		return DIAGNOSTIC_KEY_PRIORITY;
	}
	return OTHER_KEY_PRIORITY;
}

export type { DiagnosticProjection, ProjectionOptions, ProjectionTruncation };
export { projectDiagnosticValue, serializedByteLength, truncateUtf8 };
