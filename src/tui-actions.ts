import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import type { Action, ActionChoice, ActionField, Actor, ErrorEnvelope, WorkView } from "./model.js";
import type { ApplicationService } from "./service.js";
import {
	type ActionDraft,
	type ActionIntent,
	type ActionPanelState,
	buildCommandInput,
	preview,
	showActionPanel,
} from "./tui-action-panel.js";

export type ActionRunner = (work: WorkView, action: Action) => Promise<void>;

export function createActionRunner(service: ApplicationService, context: ExtensionContext, actor: Actor): ActionRunner {
	const drafts = new Map<string, ActionDraft>();
	return async (work, action) => {
		const key = `${work.workId}:${action.kind}`;
		const draft = drafts.get(key) ?? { values: new Map<string, string>(), pending: undefined, failure: undefined };
		drafts.set(key, draft);
		if (await runActionPanel(service, context, actor, { work, action, draft })) drafts.delete(key);
	};
}

/**
 * Each field edit, confirmation, and submission runs between panel showings because Pi gives
 * `ui.editor`, `ui.select`, and `ui.custom` one shared slot and restores the User prompt on close.
 */
async function runActionPanel(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	state: ActionPanelState,
): Promise<boolean> {
	for (;;) {
		const step = await runActionStep(service, context, actor, state);
		if (step !== "continue") return step === "done";
	}
}

type ActionStep = "done" | "abandoned" | "continue";

async function runActionStep(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	state: ActionPanelState,
): Promise<ActionStep> {
	const intent = await showActionPanel(context, state);
	const steps = {
		back: async (): Promise<ActionStep> => "abandoned",
		discard: async (): Promise<ActionStep> => discardDraft(state.draft),
		submit: async (): Promise<ActionStep> =>
			(await submitAction(service, context, actor, state)) ? "done" : "continue",
		edit: async (): Promise<ActionStep> => editStep(context, state, intent),
	} satisfies Record<ActionIntent["kind"], () => Promise<ActionStep>>;
	return steps[intent.kind]();
}

async function editStep(context: ExtensionContext, state: ActionPanelState, intent: ActionIntent): Promise<ActionStep> {
	if (intent.kind === "edit") await editField(context, intent.field, state.draft);
	return "continue";
}

function discardDraft(draft: ActionDraft): ActionStep {
	draft.values.clear();
	return "done";
}

async function editField(context: ExtensionContext, field: ActionField, draft: ActionDraft): Promise<void> {
	if (field.input.kind === "choice") return editChoice(context, field, field.input.choices, draft);
	const value = await context.ui.editor(field.label, draft.values.get(field.name) ?? field.current);
	if (value !== undefined) draft.values.set(field.name, editedValue(field, value));
}

function editedValue(field: ActionField, value: string): string {
	return field.input.kind === "integer" ? value.trim() : value;
}

async function editChoice(
	context: ExtensionContext,
	field: ActionField,
	choices: readonly ActionChoice[],
	draft: ActionDraft,
): Promise<void> {
	if (choices.length === 0) {
		context.ui.notify(`${field.label} has no available options.`, "error");
		return;
	}
	const options = choices.map(choiceOption);
	const selected = await context.ui.select(field.label, options);
	const choice = selected === undefined ? undefined : choices[options.indexOf(selected)];
	if (choice !== undefined) draft.values.set(field.name, choice.value);
}

function choiceOption(choice: ActionChoice): string {
	return choice.description === undefined ? choice.label : `${choice.label} - ${choice.description}`;
}

async function submitAction(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	state: ActionPanelState,
): Promise<boolean> {
	if (!(await confirmed(context, state))) return false;
	const { work, action, draft } = state;
	draft.pending ??= {
		input: buildCommandInput(action.fields, draft.values),
		revision: work.revision,
		commandId: `tui:${nanoid()}`,
	};
	return performAttempt(service, context, actor, state);
}

async function confirmed(context: ExtensionContext, state: ActionPanelState): Promise<boolean> {
	const confirmation = state.action.confirmation;
	if (confirmation === undefined) return true;
	const changes = state.action.fields
		.filter((field) => state.draft.values.has(field.name))
		.map((field) => `${field.label}: ${preview(field.current ?? "not set")} -> ${valuePreview(state, field)}`);
	const message = changes.length === 0 ? confirmation : `${confirmation}\n\n${changes.join("\n")}`;
	return context.ui.confirm(state.action.label, message);
}

function valuePreview(state: ActionPanelState, field: ActionField): string {
	return preview(state.draft.values.get(field.name) ?? "");
}

async function performAttempt(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	state: ActionPanelState,
): Promise<boolean> {
	const { work, action, draft } = state;
	const attempt = draft.pending;
	if (attempt === undefined) return false;
	try {
		const result = await service.perform({
			action: action.kind,
			workId: work.workId,
			input: attempt.input,
			meta: { commandId: attempt.commandId, actor, expectedWorkRevision: attempt.revision, schemaVersion: 1 },
		});
		return settleResult(service, context, draft, result);
	} catch (error) {
		// An unknown outcome retains the exact attempt so a retry cannot become a second decision.
		draft.failure = unknownOutcome(error instanceof Error ? error.message : String(error));
		return false;
	}
}

function settleResult(
	service: ApplicationService,
	context: ExtensionContext,
	draft: ActionDraft,
	result: Awaited<ReturnType<ApplicationService["perform"]>>,
): boolean {
	if (!("error" in result)) return completeSubmission(service, context, draft, result.value.nextAction);
	// A rejected command is a settled outcome, so the retained attempt must not be resent.
	draft.pending = undefined;
	draft.failure = result.error;
	return false;
}

function completeSubmission(
	service: ApplicationService,
	context: ExtensionContext,
	draft: ActionDraft,
	nextAction: string,
): boolean {
	draft.pending = undefined;
	draft.failure = undefined;
	void service.processPendingEffects().catch((error) => context.ui.notify(String(error), "error"));
	context.ui.notify(`Action complete: ${nextAction}`, "info");
	return true;
}

function unknownOutcome(summary: string): ErrorEnvelope {
	return {
		code: "external-failure",
		summary,
		retryable: true,
		remediation: "Retry the pending command; Khala resends the identical decision.",
		evidenceRefs: [],
	};
}
