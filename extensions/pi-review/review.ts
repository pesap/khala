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
			context.ui.setWidget("pi-review", ["Review active · /end-review returns to coding"]);
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
			context.ui.setWidget("pi-review", ["Review active · /end-review returns to coding"]);
		}
	});
}

async function resolveTarget(args: string | undefined, context: ExtensionContext): Promise<string | null> {
	const direct = args?.trim() ?? "";
	if (direct.length > 0) {
		return direct;
	}
	const selected = await context.ui.select("Select review scope:", [...REVIEW_OPTIONS]);
	if (selected === undefined) {
		return null;
	}
	if (selected === REVIEW_OPTIONS[0]) {
		return "uncommitted changes (staged, unstaged, and untracked)";
	}
	if (selected === REVIEW_OPTIONS[1]) {
		const branch = await context.ui.input("Base branch:", "main");
		return branch === undefined || branch.trim().length === 0 ? null : `changes against branch ${branch.trim()}`;
	}
	if (selected === REVIEW_OPTIONS[2]) {
		const commit = await context.ui.input("Commit SHA:", "");
		return commit === undefined || commit.trim().length === 0 ? null : `commit ${commit.trim()}`;
	}
	if (selected === REVIEW_OPTIONS[3]) {
		const pullRequest = await context.ui.input("GitHub PR number or URL:", "");
		return pullRequest === undefined || pullRequest.trim().length === 0
			? null
			: `GitHub pull request ${pullRequest.trim()}`;
	}
	const paths = await context.ui.editor("Files or folders, one per line:", ".");
	return paths === undefined || paths.trim().length === 0 ? null : `snapshot of:\n${paths.trim()}`;
}

function readActiveState(context: ExtensionContext): boolean {
	let current = false;
	for (const entry of context.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== REVIEW_STATE) {
			continue;
		}
		// SAFETY: the cast is immediately constrained to the persisted shape below.
		const data = entry.data as ReviewState | null | undefined;
		if (data === null || data === undefined || Object(data) !== data || Array.isArray(data)) {
			continue;
		}
		if (data.active === true || data.active === false) {
			current = data.active;
		}
	}
	return current;
}

type ReviewState = Readonly<{ active?: boolean | undefined; target?: string | undefined }>;
