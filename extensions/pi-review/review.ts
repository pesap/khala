import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject, JsonValue } from "../../src/model.js";

const REVIEW_STATE = "khala-review-state";
const REVIEW_OPTIONS = [
	"Review uncommitted changes",
	"Review against a base branch",
	"Review a commit",
	"Review a GitHub pull request",
	"Review files or folders",
] as const;
const REVIEW_WIDGET = ["Review active  /end-review returns to coding"];
let active = false;

const REVIEW_RUBRIC = `Review only the requested scope. Report actionable findings introduced by the change, ordered by priority [P0] through [P3]. Each finding must include a short title, exact path and line, concrete impact, evidence, and a fix direction. Do not edit files, commit, push, or claim acceptance. End with a Human Reviewer Callouts (Non-Blocking) section and include only applicable callouts.`;

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Review uncommitted changes, a branch, commit, pull request, or snapshot",
		handler: async (args, context) => {
			if (!context.hasUI) throw new Error("The /review command requires a UI-capable Pi session.");
			if (active) {
				context.ui.notify("A review is active. Use /end-review first.", "warning");
				return;
			}
			await context.waitForIdle();
			const target = await resolveTarget(args, context);
			if (target === null) {
				return;
			}
			startReview(pi, context, target);
		},
	});

	pi.registerCommand("end-review", {
		description: "End the active code review",
		handler: async (_args, context) => {
			if (!active) {
				context.ui.notify("No review is active.", "info");
				return;
			}
			active = false;
			setReviewWidget(context);
			pi.appendEntry(REVIEW_STATE, { active: false });
			context.ui.notify("Review ended. Findings remain in the session for follow-up.", "info");
		},
	});

	pi.on("session_start", (_event, context) => {
		active = readActiveState(context);
		setReviewWidget(context);
	});
	pi.on("session_tree", (_event, context) => {
		active = readActiveState(context);
		setReviewWidget(context);
	});
}
async function resolveTarget(args: string | undefined, context: ExtensionContext): Promise<string | null> {
	const direct = reviewArgument(args);
	if (direct.length > 0) return direct;
	const selected = await context.ui.select("Select review scope:", [...REVIEW_OPTIONS]);
	return selectReviewTargetOrCancel(selected, context);
}

function setReviewWidget(context: ExtensionContext): void {
	context.ui.setWidget("pi-review", active ? REVIEW_WIDGET : undefined);
}

function startReview(pi: ExtensionAPI, context: ExtensionContext, target: string): void {
	active = true;
	setReviewWidget(context);
	pi.appendEntry(REVIEW_STATE, { active: true, target });
	try {
		pi.sendUserMessage(`${REVIEW_RUBRIC}\n\nReview target:\n${target}`);
	} catch (error) {
		active = false;
		setReviewWidget(context);
		pi.appendEntry(REVIEW_STATE, { active: false });
		context.ui.notify(`Could not start the review: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function reviewArgument(args: string | undefined): string {
	return args === undefined ? "" : args.trim();
}
async function selectReviewTargetOrCancel(
	selected: string | undefined,
	context: ExtensionContext,
): Promise<string | null> {
	if (selected === undefined) return null;
	if (REVIEW_OPTIONS.findIndex((option) => option === selected) < 0) return null;
	return selectReviewTarget(selected, context);
}

async function selectReviewTarget(selected: string, context: ExtensionContext): Promise<string | null> {
	const index = REVIEW_OPTIONS.findIndex((option) => option === selected);
	if (index === 0) return "uncommitted changes (staged, unstaged, and untracked)";
	if (index > 0 && index < 4) return promptReviewTarget(index, context);
	const paths = await context.ui.editor("Files or folders, one per line:", ".");
	return nonBlankReviewTarget(paths, "snapshot of:\n");
}

async function promptReviewTarget(index: number, context: ExtensionContext): Promise<string | null> {
	const prompts = ["Base branch:", "Commit SHA:", "GitHub PR number or URL:"];
	const defaults = ["main", "", ""];
	const value = await context.ui.input(prompts[index - 1] ?? "", defaults[index - 1] ?? "");
	return nonBlankReviewTarget(value, reviewTargetPrefix(index));
}

function reviewTargetPrefix(index: number): string {
	return ["", "changes against branch ", "commit ", "GitHub pull request "][index] ?? "";
}

function nonBlankReviewTarget(value: string | undefined, prefix: string): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed.length === 0 ? null : `${prefix}${trimmed}`;
}

function readActiveState(context: ExtensionContext): boolean {
	let current = false;
	for (const entry of context.sessionManager.getBranch()) {
		if (!isReviewStateEntry(entry)) continue;
		// SAFETY: Pi custom entries are persisted as JSON values; isReviewState validates the object shape below.
		const data = entry.data as JsonValue | undefined;
		const active = isReviewState(data);
		if (active !== undefined) current = active;
	}
	return current;
}

function isReviewStateEntry(entry: {
	type: string;
	customType?: string;
	data?: unknown;
}): entry is { data?: unknown } & { type: "custom"; customType: typeof REVIEW_STATE } {
	return entry.type === "custom" && entry.customType === REVIEW_STATE;
}
function isReviewState(value: JsonValue | undefined): boolean | undefined {
	if (!isReviewStateObject(value)) return undefined;
	return readReviewActive(value["active"]);
}

function isReviewStateObject(value: JsonValue | undefined): value is ReviewState {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function readReviewActive(value: JsonValue | undefined): boolean | undefined {
	if (value === true) return true;
	if (value === false) return false;
	return undefined;
}

type ReviewState = JsonObject;
