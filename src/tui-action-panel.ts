import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	ScrollView,
	type SelectItem,
	SelectList,
	Spacer,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { Action, ActionField, ErrorEnvelope, JsonObject, JsonValue, WorkView } from "./model.js";
import {
	addHeading,
	addKeyValueRows,
	addPanelKeybindings,
	isPanelBack,
	NAVIGATION_FOOTER,
	selectableComponent,
	selectorTheme,
} from "./tui-pages.js";

export type ActionAttempt = Readonly<{ input: JsonObject; revision: number; commandId: string }>;
export type ActionDraft = {
	values: Map<string, string>;
	pending: ActionAttempt | undefined;
	failure: ErrorEnvelope | undefined;
};

export type ActionPanelState = Readonly<{ work: WorkView; action: Action; draft: ActionDraft }>;

/**
 * Pi renders `ui.editor`, `ui.select`, and `ui.custom` into the same slot, and closing any of them
 * restores the User prompt rather than the calling component. The panel therefore resolves an intent
 * and its caller performs the field edit, confirmation, or submission between showings.
 */
export type ActionIntent =
	| Readonly<{ kind: "edit"; field: ActionField }>
	| Readonly<{ kind: "submit" }>
	| Readonly<{ kind: "discard" }>
	| Readonly<{ kind: "back" }>;

const INFO_LABEL_WIDTH = "Remediation".length;
const PREVIEW_WIDTH = 60;
const SUBMIT_VALUE = "submit";
const DISCARD_VALUE = "discard";

type MutableJsonObject = { [key: string]: JsonValue | undefined };

export async function showActionPanel(context: ExtensionContext, state: ActionPanelState): Promise<ActionIntent> {
	return context.ui.custom<ActionIntent>((tui, theme, _keybindings, done) => {
		const items = actionItems(state);
		const content = new Container();
		addHeading(content, theme, state.action.label);
		content.addChild(new Spacer(1));
		addKeyValueRows(content, theme, actionInfoRows(state), INFO_LABEL_WIDTH);
		const scroll = new ScrollView(content, { overscroll: "contain", scrollbar: "auto" });
		const controls = new Container();
		const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), selectorTheme(theme));
		controls.addChild(list);
		addPanelKeybindings(controls, theme, NAVIGATION_FOOTER);
		list.onSelect = (item) => {
			const intent = selectionIntent(state, item.value);
			if (intent !== undefined) done(intent);
		};
		list.onCancel = () => done({ kind: "back" });
		return selectableComponent(
			new VStack([scroll, new Spacer(1), { component: controls, shrink: 0 }]),
			list,
			tui,
			() => done({ kind: "back" }),
			(data) => {
				if (!isPanelBack(data)) return false;
				done({ kind: "back" });
				return true;
			},
		);
	});
}

/** A blocked submit row yields no intent, so selecting it cannot submit an incomplete action. */
function selectionIntent(state: ActionPanelState, value: string): ActionIntent | undefined {
	const field = state.action.fields.find((candidate) => candidate.name === value);
	if (field !== undefined) return fieldIntent(state, field);
	return value === DISCARD_VALUE ? { kind: "discard" } : submitIntent(state);
}

function fieldIntent(state: ActionPanelState, field: ActionField): ActionIntent | undefined {
	return state.draft.pending === undefined ? { kind: "edit", field } : undefined;
}

function submitIntent(state: ActionPanelState): ActionIntent | undefined {
	return unmetRequirement(state.action, state.draft.values) === undefined ? { kind: "submit" } : undefined;
}

function actionItems(state: ActionPanelState): SelectItem[] {
	const fields = state.action.fields.map((field) => ({
		value: field.name,
		label: `${field.label}${field.requirement === "required" ? " *" : ""}`,
		description: fieldDescription(field, state.draft.values),
	}));
	return [...fields, submitItem(state), ...discardItems(state)];
}

function actionInfoRows(state: ActionPanelState): readonly (readonly [string, string])[] {
	return [
		["Effect", state.action.effect],
		...requirementRows(state),
		["Submitting", `${state.work.workId} at saved revision ${state.work.revision}`],
		...pendingRows(state),
		...failureRows(state),
	];
}

function requirementRows(state: ActionPanelState): readonly (readonly [string, string])[] {
	const requirement = unmetRequirement(state.action, state.draft.values);
	return requirement === undefined ? [] : [["Requires", requirement]];
}

function pendingRows(state: ActionPanelState): readonly (readonly [string, string])[] {
	const pending = state.draft.pending;
	return pending === undefined
		? []
		: [
				[
					"Pending",
					`Command ${pending.commandId} at revision ${pending.revision} reported no outcome; fields are locked until retry`,
				],
			];
}

function failureRows(state: ActionPanelState): readonly (readonly [string, string])[] {
	const failure = state.draft.failure;
	if (failure === undefined) return [];
	return [["Outcome", `${failure.code}: ${failure.summary}`] as const, ["Remediation", failure.remediation] as const];
}

function submitItem(state: ActionPanelState): SelectItem {
	const requirement = unmetRequirement(state.action, state.draft.values);
	if (requirement !== undefined) return { value: SUBMIT_VALUE, label: "Submit", description: requirement };
	return state.draft.pending === undefined
		? { value: SUBMIT_VALUE, label: state.action.label, description: "Sends this action to Khala" }
		: { value: SUBMIT_VALUE, label: "Retry pending command", description: "Re-sends the identical command" };
}

function discardItems(state: ActionPanelState): SelectItem[] {
	if (state.draft.pending !== undefined || state.draft.values.size === 0) return [];
	return [
		{
			value: DISCARD_VALUE,
			label: "Discard draft values",
			description: `Clears ${state.draft.values.size} entered value(s)`,
		},
	];
}

function fieldDescription(field: ActionField, values: ReadonlyMap<string, string>): string {
	const draft = values.get(field.name);
	if (draft !== undefined) return preview(draft);
	if (field.current !== undefined) return `unchanged: ${preview(field.current)}`;
	return field.hint ?? "not set";
}

export function preview(value: string): string {
	return truncateToWidth(value.replace(/\s+/gu, " ").trim(), PREVIEW_WIDTH, "...");
}

export function unmetRequirement(action: Action, values: ReadonlyMap<string, string>): string | undefined {
	return (
		requiredRequirement(action.fields, values) ??
		conditionalRequirement(action.fields, values) ??
		groupRequirement(action.fields, values) ??
		integerRequirement(action.fields, values)
	);
}

function requiredRequirement(fields: readonly ActionField[], values: ReadonlyMap<string, string>): string | undefined {
	const field = fields.find((candidate) => candidate.requirement === "required" && !hasValue(values, candidate.name));
	return field === undefined ? undefined : `${field.label} is required.`;
}

function conditionalRequirement(
	fields: readonly ActionField[],
	values: ReadonlyMap<string, string>,
): string | undefined {
	const field = fields.find((candidate) => conditionalFieldMissing(candidate, fields, values));
	return field?.requiredWhen === undefined
		? undefined
		: `${field.label} is required when ${dependencyLabel(fields, field.requiredWhen.field)} is ${field.requiredWhen.value}.`;
}

function dependencyLabel(fields: readonly ActionField[], name: string): string {
	return fields.find((candidate) => candidate.name === name)?.label ?? name;
}

function conditionalFieldMissing(
	field: ActionField,
	fields: readonly ActionField[],
	values: ReadonlyMap<string, string>,
): boolean {
	return dependencyMatches(field, fields, values) && !hasValue(values, field.name);
}

function dependencyMatches(
	field: ActionField,
	fields: readonly ActionField[],
	values: ReadonlyMap<string, string>,
): boolean {
	const dependency = field.requiredWhen;
	if (dependency === undefined) return false;
	if (!fields.some((candidate) => candidate.name === dependency.field)) return false;
	return values.get(dependency.field) === dependency.value;
}

function groupRequirement(fields: readonly ActionField[], values: ReadonlyMap<string, string>): string | undefined {
	const group = fields.filter((field) => field.requirement === "one-of-group");
	return group.length > 0 && group.every((field) => !hasValue(values, field.name))
		? "Change at least one term."
		: undefined;
}

function integerRequirement(fields: readonly ActionField[], values: ReadonlyMap<string, string>): string | undefined {
	const field = fields.find((candidate) => invalidIntegerField(candidate, values));
	return field === undefined || field.input.kind !== "integer"
		? undefined
		: `${field.label} must be a whole number of ${field.input.min} or more.`;
}

function invalidIntegerField(field: ActionField, values: ReadonlyMap<string, string>): boolean {
	if (field.input.kind !== "integer") return false;
	if (!hasValue(values, field.name)) return false;
	return !atLeastMinimum(values.get(field.name), field.input.min);
}

function atLeastMinimum(text: string | undefined, min: number): boolean {
	const value = Number((text ?? "").trim());
	return Number.isSafeInteger(value) && value >= min;
}

function hasValue(values: ReadonlyMap<string, string>, fieldName: string): boolean {
	return (values.get(fieldName) ?? "").trim().length > 0;
}

export function buildCommandInput(fields: readonly ActionField[], values: ReadonlyMap<string, string>): JsonObject {
	const input: MutableJsonObject = {};
	const nested = new Map<string, MutableJsonObject>();
	for (const field of fields) addFieldInput(input, nested, field, values.get(field.name));
	for (const [prefix, group] of nested) input[prefix] = group;
	return input;
}

function addFieldInput(
	input: MutableJsonObject,
	nested: Map<string, MutableJsonObject>,
	field: ActionField,
	value: string | undefined,
): void {
	if (value === undefined) return;
	const converted = convertValue(field, value);
	const separator = field.name.indexOf(".");
	if (separator < 0) {
		input[field.name] = converted;
		return;
	}
	const prefix = field.name.slice(0, separator);
	const group = nested.get(prefix) ?? {};
	group[field.name.slice(separator + 1)] = converted;
	nested.set(prefix, group);
}

function convertValue(field: ActionField, value: string): JsonValue {
	if (field.input.kind === "integer") return Number(value.trim());
	if (field.input.kind === "lines") return value.split("\n").filter((line) => line.trim().length > 0);
	return value;
}
