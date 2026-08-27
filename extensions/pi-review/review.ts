import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REVIEW_STATE = "khala-review-state";
const REVIEW_OPTIONS = [
	"Review uncommitted changes",
	"Review against a base branch",
	"Review a commit",
	"Review a GitHub pull request",
	"Review files or folders",
] as const;
let active = false;

const REVIEW_RUBRIC = `Review only the requested scope. Report actionable findings introduced by the change, ordered by priority [P0] through [P3]. Each finding must include a short title, exact path and line, concrete impact, evidence, and a fix direction. Do not edit files, commit, push, or claim acceptance. End with a Human Reviewer Callouts (Non-Blocking) section and include only applicable callouts.`;

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Review uncommitted changes, a branch, commit, pull request, or snapshot",
		handler: async (args, context) => {
			if (!context.hasUI) {
				context.ui.notify("Review requires interactive mode.", "error");
				return;
			}
			if (active) {
				context.ui.notify("A review is active. Use /end-review first.", "warning");
				return;
			}
			const target = await resolveTarget(args, context);
			if (target === null) {
				return;
			}
			active = true;
			context.ui.setWidget("pi-review", ["Review active  /end-review returns to coding"]);
			pi.appendEntry(REVIEW_STATE, { active: true, target });
			pi.sendUserMessage(`${REVIEW_RUBRIC}\n\nReview target:\n${target}`);
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
			context.ui.setWidget("pi-review", undefined);
			pi.appendEntry(REVIEW_STATE, { active: false });
			context.ui.notify("Review ended. Findings remain in the session for follow-up.", "info");
		},
	});

	pi.on("session_start", (_event, context) => {
		active = readActiveState(context);
		if (active) {
			context.ui.setWidget("pi-review", ["Review active  /end-review returns to coding"]);
		}
	});
}

// oxlint-disable-next-line complexity
async function resolveTarget(args: string | undefined, context: ExtensionContext): Promise<string | null> {
	const direct = args?.trim() ?? "";
	if (direct.length > 0) return direct;
	const selected = await context.ui.select("Select review scope:", [...REVIEW_OPTIONS]);
	if (selected === undefined) return null;
	return selectReviewTarget(selected, context);
}

// oxlint-disable-next-line complexity
async function selectReviewTarget(selected: string, context: ExtensionContext): Promise<string | null> {
	const index = REVIEW_OPTIONS.findIndex((option) => option === selected);
	if (index === 0) return "uncommitted changes (staged, unstaged, and untracked)";
	const prompts = ["Base branch:", "Commit SHA:", "GitHub PR number or URL:"];
	if (index < 4) {
		const value = await context.ui.input(prompts[index - 1] ?? "", index === 1 ? "main" : "");
		return nonBlankReviewTarget(value, reviewTargetPrefix(index));
	}
	const paths = await context.ui.editor("Files or folders, one per line:", ".");
	return nonBlankReviewTarget(paths, "snapshot of:\n");
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
		// SAFETY: custom session entries are validated by isReviewState before fields are read.
		const data = entry.data as ReviewState | null | undefined;
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

// oxlint-disable-next-line complexity
function isReviewState(value: ReviewState | null | undefined): boolean | undefined {
	if (value === null || value === undefined || Object(value) !== value || Array.isArray(value)) return undefined;
	const active = value.active;
	return active === true || active === false ? active : undefined;
}

type ReviewState = Readonly<{ active?: boolean | undefined; target?: string | undefined }>;
