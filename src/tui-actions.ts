import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Editor, getKeybindings, Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import type { Action, Actor, JsonObject, WorkView } from "./model.js";
import type { ApplicationService } from "./service.js";

type Attempt = Readonly<{ input: JsonObject; revision: number; commandId: string }>;
type Draft = { values: Map<string, string>; input: JsonObject; pending: Attempt | undefined };
export type ActionRunner = (work: WorkView, action: Action) => Promise<void>;
const TEXT_FIELDS: ReadonlyMap<Action["kind"], string> = new Map([
	["fail-work", "reason"],
	["run-oracle", "subject"],
	["rename-work", "title"],
	["amend-budget", "maxTokens"],
]);
const TERM_FIELDS = [
	"objective",
	"context",
	"scope",
	"acceptanceCriteria",
	"constraints",
	"validation",
	"allowedPaths",
];
const LIST_FIELDS = new Set(["acceptanceCriteria", "constraints", "validation", "allowedPaths"]);
const CONSEQUENTIAL = new Set<Action["kind"]>(["cancel", "fail-work", "amend-budget"]);

export function createActionRunner(service: ApplicationService, context: ExtensionContext, actor: Actor): ActionRunner {
	const drafts = new Map<string, Draft>();
	return async (work, action) => {
		const key = `${work.workId}:${action.kind}`;
		const draft = drafts.get(key) ?? { values: new Map<string, string>(), input: {}, pending: undefined };
		drafts.set(key, draft);
		const completed = await actionMenu(service, context, actor, work, action, draft);
		if (completed) drafts.delete(key);
	};
}

async function actionMenu(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	work: WorkView,
	action: Action,
	draft: Draft,
): Promise<boolean> {
	for (;;) {
		const choice = await context.ui.select(`${action.label}: saved draft`, draftChoices(draft));
		if (choice === "Edit") {
			await editDraft(context, action, draft);
			continue;
		}
		if (!isSubmitChoice(choice)) return choice === "Discard";
		return submitDraft(service, context, actor, work, action, draft);
	}
}

function draftChoices(draft: Draft): string[] {
	return draft.pending === undefined ? ["Edit", "Submit", "Discard", "Back"] : ["Retry pending command", "Back"];
}

function isSubmitChoice(choice: string | undefined): boolean {
	return choice === "Submit" || choice === "Retry pending command";
}

async function editDraft(context: ExtensionContext, action: Action, draft: Draft): Promise<void> {
	if (action.kind === "record-review") return editReview(context, draft);
	if (action.kind === "amend-terms") return editTerms(context, draft);
	const field = TEXT_FIELDS.get(action.kind);
	if (field !== undefined) await editField(context, field, draft);
}

async function editTerms(context: ExtensionContext, draft: Draft): Promise<void> {
	const field = await context.ui.select("Term to amend:", TERM_FIELDS);
	if (field === undefined) return;
	if (TERM_FIELDS.includes(field)) await editField(context, field, draft);
}

async function editReview(context: ExtensionContext, draft: Draft): Promise<void> {
	const status = await context.ui.select("Provider review result:", ["changes-requested", "merged", "closed"]);
	if (status === undefined) return;
	draft.values.set("status", status);
	draft.input = { ...draft.input, status };
	await editField(context, "feedback", draft);
}

async function editField(context: ExtensionContext, field: string, draft: Draft): Promise<void> {
	await context.ui.custom<void>((tui, theme, _bindings, done) => {
		const color = (text: string): string => theme.fg("accent", text);
		const editor = new Editor(tui, {
			borderColor: color,
			selectList: { selectedPrefix: color, selectedText: color, description: color, scrollInfo: color, noMatch: color },
		});
		editor.setText(draft.values.get(field) ?? "");
		editor.disableSubmit = true;
		const container = new Container();
		container.addChild(new Text(`${field}: Escape saves the draft; use Submit in the action menu.`, 1, 0));
		container.addChild(editor);
		const save = (): void => {
			const text = editor.getExpandedText();
			draft.values.set(field, text);
			draft.input = { ...draft.input, ...fieldInput(field, text) };
		};
		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				const bindings = getKeybindings();
				if (bindings.matches(data, "tui.select.cancel")) {
					save();
					done();
					return;
				}
				if (bindings.matches(data, "tui.input.submit")) editor.insertTextAtCursor("\n");
				else editor.handleInput(data);
				save();
				tui.requestRender();
			},
		};
	});
}

function fieldInput(field: string, text: string): JsonObject {
	if (field === "feedback") return { feedback: feedbackLines(text) };
	if (field === "maxTokens") return {};
	return { [field]: LIST_FIELDS.has(field) ? text.split("\n").filter((line) => line.trim().length > 0) : text };
}

function feedbackLines(text: string): string[] {
	return text.length === 0 ? [] : [text];
}

function submissionInput(action: Action, draft: Draft): JsonObject {
	if (action.kind !== "amend-budget") return draft.input;
	const maxTokens = Number(draft.values.get("maxTokens"));
	if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
		throw new Error("Enter a positive whole-number token budget.");
	return { maxTokens };
}

async function confirmed(context: ExtensionContext, action: Action): Promise<boolean> {
	if (action.confirmation !== undefined) return context.ui.confirm(action.label, action.confirmation);
	if (CONSEQUENTIAL.has(action.kind))
		return context.ui.confirm(action.label, "Apply this consequential change to Work?");
	return true;
}

async function submitDraft(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	work: WorkView,
	action: Action,
	draft: Draft,
): Promise<boolean> {
	try {
		if (!(await confirmed(context, action))) return false;
		draft.pending ??= { input: submissionInput(action, draft), revision: work.revision, commandId: `tui:${nanoid()}` };
		return await performDraft(service, context, actor, work, action, draft);
	} catch (error) {
		context.ui.notify(String(error), "error");
		return false;
	}
}

async function performDraft(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	work: WorkView,
	action: Action,
	draft: Draft,
): Promise<boolean> {
	const attempt = draft.pending;
	if (attempt === undefined) return false;
	const result = await service.perform({
		action: action.kind,
		workId: work.workId,
		input: attempt.input,
		meta: { commandId: attempt.commandId, actor, expectedWorkRevision: attempt.revision, schemaVersion: 1 },
	});
	draft.pending = undefined;
	if ("error" in result) {
		context.ui.notify(
			`${result.error.summary}\n${result.error.remediation}\nDraft retained. Reopen the action to review and submit again.`,
			"error",
		);
		return false;
	}
	void service.processPendingEffects().catch((error) => context.ui.notify(String(error), "error"));
	context.ui.notify(`Action complete: ${result.value.nextAction}`, "info");
	return true;
}
