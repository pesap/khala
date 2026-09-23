import type {
	ActionChoice,
	ActionField,
	ActionFieldRequirement,
	ActionInputKind,
	ActionKind,
	WorkTerms,
	WorkView,
} from "./model.js";

export type ActionDescriptor = Readonly<{
	label: string;
	effect: string;
	fields: readonly ActionField[];
	confirmation?: string | undefined;
}>;

function field(
	name: string,
	label: string,
	requirement: ActionFieldRequirement,
	input: ActionInputKind,
	hint?: string,
): ActionField {
	return { name, label, requirement, input, hint };
}

function requiredText(name: string, label: string, hint?: string): ActionField {
	return field(name, label, "required", { kind: "text" }, hint);
}

function optionalText(name: string, label: string, hint?: string): ActionField {
	return field(name, label, "optional", { kind: "text" }, hint);
}

function requiredLines(name: string, label: string, hint?: string): ActionField {
	return field(name, label, "required", { kind: "lines" }, hint);
}

function optionalLines(name: string, label: string, hint?: string): ActionField {
	return field(name, label, "optional", { kind: "lines" }, hint);
}

function termField(name: string, label: string, input: ActionInputKind = { kind: "text" }): ActionField {
	return field(name, label, "one-of-group", input);
}

function requiredInteger(name: string, label: string, min: number, hint?: string): ActionField {
	return field(name, label, "required", { kind: "integer", min }, hint);
}

function requiredChoice(name: string, label: string, choices: readonly ActionChoice[]): ActionField {
	return field(name, label, "required", { kind: "choice", choices });
}

function termFields(): readonly ActionField[] {
	return [
		termField("objective", "Objective"),
		termField("context", "Repository context"),
		termField("scope", "Scope"),
		termField("acceptanceCriteria", "Acceptance criteria", { kind: "lines" }),
		termField("constraints", "Constraints", { kind: "lines" }),
		termField("validation", "Validation commands", { kind: "lines" }),
		termField("allowedPaths", "Allowed paths", { kind: "lines" }),
	].map((item) => (item.input.kind === "lines" ? { ...item, hint: "One entry per line" } : item));
}

const actionDescriptors = {
	admit: {
		label: "Admit Work",
		effect: "Admits this Work and creates its first Mission.",
		fields: [],
	},
	"request-input": {
		label: "Request User input",
		effect: "Pauses admission and asks the User for missing intent.",
		fields: [requiredText("reason", "Reason"), optionalLines("missing", "Missing information")],
	},
	"amend-terms": {
		label: "Amend terms",
		effect: "Changes this Work's terms before a Mission exists.",
		fields: termFields(),
	},
	"retry-admission": {
		label: "Retry admission",
		effect: "Clears the recorded admission failure and asks the Conclave to admit this Work again.",
		fields: [],
	},
	"amend-mission": {
		label: "Amend Mission",
		effect: "Supersedes the current Mission with a new one carrying the amended terms.",
		fields: [requiredText("reason", "Reason"), optionalLines("evidence", "Evidence"), ...termFields()],
	},
	"launch-observer": {
		label: "Gather repository context",
		effect: "Launches the read-only Observer to gather missing repository context.",
		fields: [],
	},
	"record-assessment": {
		label: "Record assessment",
		effect: "Records one read-only Observer assessment of this Work.",
		fields: [requiredText("summary", "Summary"), requiredLines("evidence", "Evidence")],
	},
	"start-execution": {
		label: "Start Execution",
		effect: "Starts an Executor for the admitted Mission in its own sandbox.",
		fields: [],
	},
	"record-signal": {
		label: "Record Signal",
		effect: "Records Executor progress, a blocker, or handoff readiness.",
		fields: [
			requiredChoice("kind", "Signal kind", [
				{ value: "progress", label: "Progress", description: "Work continues; no decision is required." },
				{ value: "blocked", label: "Blocked", description: "Stops for a Conclave decision." },
				{ value: "ready", label: "Ready", description: "Offers the change for handoff review." },
			]),
			requiredText("summary", "Summary"),
			requiredLines("evidence", "Evidence"),
		],
	},
	"commit-sandbox": {
		label: "Commit sandbox changes",
		effect: "Commits the sandbox worktree to its Execution branch.",
		fields: [],
	},
	"run-validation": {
		label: "Run validation",
		effect: "Runs the Work's declared validation commands in isolation.",
		fields: [],
	},
	"create-review-request": {
		label: "Create review request",
		effect: "Creates or reconciles the draft review request for the Execution branch.",
		fields: [],
	},
	"run-oracle": {
		label: "Run Oracle review",
		effect: "Asks the advisory Oracle to review the handoff evidence.",
		fields: [requiredText("subject", "Review subject")],
	},
	verdict: {
		label: "Record Verdict",
		effect: "Decides what happens to the Execution that is awaiting a Verdict.",
		fields: [
			requiredChoice("decision", "Decision", [
				{ value: "continue", label: "Continue", description: "Resumes the same Execution." },
				{ value: "replace", label: "Replace", description: "Stops this Execution and queues a replacement." },
				{ value: "handoff", label: "Handoff", description: "Sends the validated change to User review." },
				{
					value: "reject",
					label: "Reject",
					description: "Fails the Mission and requires a Work decision.",
				},
			]),
			requiredText("reason", "Reason"),
			requiredText("signalId", "Signal ID", "Must reference the current Signal"),
		],
	},
	"deliver-feedback": {
		label: "Deliver provider feedback",
		effect: "Authorizes bounded provider review feedback for the running Executor.",
		fields: [optionalText("observationId", "Observation ID", "Defaults to the latest observation")],
	},
	"repair-ci": {
		label: "Authorize CI repair",
		effect: "Authorizes one bounded continuation of the same idle Execution for selected current CI failures.",
		fields: [
			requiredText("observationId", "CI observation ID"),
			requiredLines(
				"evidence",
				"Selected failed check indexes",
				"One-based indexes from the numbered failed-check evidence",
			),
		],
	},
	"record-review": {
		label: "Record review",
		effect: "Records the User's review result for the published change.",
		fields: [
			requiredChoice("status", "Review result", [
				{
					value: "changes-requested",
					label: "Changes requested",
					description: "Returns the Work to the Executor with feedback.",
				},
				{ value: "merged", label: "Merged", description: "Accepts the change; the Conclave settles the Outcome." },
				{ value: "closed", label: "Closed", description: "Closes the review without acceptance." },
			]),
			{
				...optionalLines("feedback", "Review feedback", "One entry per line"),
				requiredWhen: { field: "status", value: "changes-requested" },
			},
		],
	},
	"record-outcome": {
		label: "Record Work Outcome",
		effect: "Settles provider-confirmed merge evidence and completes this Work.",
		fields: [],
	},
	cancel: {
		label: "Cancel",
		effect: "Stops this Work without recording a failure. It can be recovered after cleanup.",
		confirmation:
			"Stops this Work without recording a failure, keeps its evidence, and marks it cancelled. After cleanup, Recover can return it to admission.",
		fields: [],
	},
	recover: {
		label: "Recover",
		effect: "Restores the Executor runtime or returns cancelled Work to admission.",
		fields: [],
	},
	"reconcile-invocation": {
		label: "Reconcile held usage",
		effect: "Settles a held invocation reservation with its actual cumulative usage.",
		confirmation:
			"Settles the held reservation with the entered cumulative usage and permits Work dispatch to resume. Estimated counts corrupt the Work budget permanently.",
		fields: [
			requiredChoice("runId", "Held invocation", []),
			requiredInteger("usage.inputTokens", "Cumulative input tokens", 0, "From final usage evidence"),
			requiredInteger("usage.outputTokens", "Cumulative output tokens", 0, "From final usage evidence"),
			requiredInteger("usage.cacheHitTokens", "Cumulative cache hit tokens", 0, "From final usage evidence"),
			requiredInteger("usage.cacheMissTokens", "Cumulative cache miss tokens", 0, "From final usage evidence"),
			requiredLines("evidence", "Usage evidence", "Use provider or runtime evidence; never estimate"),
		],
	},
	"rename-work": {
		label: "Rename",
		effect: "Changes this Work's title. Nothing else about the Work changes.",
		fields: [requiredText("title", "Title")],
	},
	"amend-budget": {
		label: "Amend budget",
		effect: "Changes this Work's total token cap.",
		confirmation: "Changes the Work token cap. Dispatch resumes when the new cap covers reserved and consumed tokens.",
		fields: [requiredInteger("maxTokens", "Token cap", 1)],
	},
	"fail-work": {
		label: "Mark as failed",
		effect:
			"Ends this Work as failed and records why it could not succeed. The Work and its evidence remain in History, but it cannot be recovered.",
		confirmation:
			"Stops any running Executor, records the reason as this Work's failure, and prevents recovery. The Work and its evidence remain in History.",
		fields: [requiredText("reason", "Reason")],
	},
} satisfies Readonly<Record<ActionKind, ActionDescriptor>>;

type CurrentResolver = (fieldName: string, work: WorkView) => string | undefined;

const termValueReaders = {
	objective: (terms) => terms.objective,
	context: (terms) => terms.context,
	scope: (terms) => terms.scope,
	acceptanceCriteria: (terms) => terms.acceptanceCriteria.join("\n"),
	constraints: (terms) => terms.constraints.join("\n"),
	validation: (terms) => terms.validation.join("\n"),
	allowedPaths: (terms: WorkTerms) => terms.allowedPaths.join("\n"),
} satisfies Readonly<Record<string, (terms: WorkTerms) => string>>;

function termCurrent(fieldName: string, work: WorkView): string | undefined {
	return Object.entries(termValueReaders).find(([name]) => name === fieldName)?.[1](work.terms);
}

function verdictSignalId(work: WorkView): string | undefined {
	if (work.execution?.blockReason === "budget-exhausted") return "budget-exhausted";
	return work.lastSignal?.signalId;
}

const currentResolvers = {
	"rename-work": (fieldName, work) => (fieldName === "title" ? work.terms.title : undefined),
	"amend-budget": (fieldName, work) => (fieldName === "maxTokens" ? String(work.terms.maxTokens) : undefined),
	"amend-terms": termCurrent,
	"amend-mission": termCurrent,
	verdict: (fieldName, work) => (fieldName === "signalId" ? verdictSignalId(work) : undefined),
	"deliver-feedback": (fieldName, work) =>
		fieldName === "observationId" ? work.lastObservation?.observationId : undefined,
	"repair-ci": (fieldName, work) => (fieldName === "observationId" ? work.lastObservation?.observationId : undefined),
} satisfies Partial<Record<ActionKind, CurrentResolver>>;

function applyCurrentValues(kind: ActionKind, fields: readonly ActionField[], work: WorkView): readonly ActionField[] {
	const resolver = Object.entries(currentResolvers).find(([candidate]) => candidate === kind)?.[1];
	if (resolver === undefined) return fields;
	return fields.map((field) => {
		const current = resolver(field.name, work);
		return current === undefined || current === "" ? field : { ...field, current };
	});
}

function invocationChoices(work: WorkView): readonly ActionChoice[] {
	return (work.activeInvocations ?? []).map(({ role, runId, state, allowance }) => ({
		value: runId,
		label: `${role} ${runId}`,
		description: `${state} reservation of ${allowance} tokens`,
	}));
}

function applyInvocationChoices(
	kind: ActionKind,
	fields: readonly ActionField[],
	work: WorkView,
): readonly ActionField[] {
	if (kind !== "reconcile-invocation") return fields;
	return fields.map((field) =>
		field.name === "runId" ? { ...field, input: { kind: "choice", choices: invocationChoices(work) } } : field,
	);
}

export function actionDescriptor(kind: ActionKind, work: WorkView): ActionDescriptor {
	const descriptor = actionDescriptors[kind];
	const withCurrentValues = applyCurrentValues(kind, descriptor.fields, work);
	return { ...descriptor, fields: applyInvocationChoices(kind, withCurrentValues, work) };
}
