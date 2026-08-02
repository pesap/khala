/**
 * Khala bundled fork of earendil-works/pi-review:
 * https://github.com/earendil-works/pi-review
 *
 * Code Review Extension (inspired by Codex's review feature)
 *
 * Provides a `/review` command that prompts the agent to review code changes.
 * Supports multiple review modes:
 * - Review a GitHub pull request (checks out the PR locally)
 * - Review against a base branch (PR style)
 * - Review uncommitted changes
 * - Review a specific commit
 * - Shared custom review instructions (applied to all review modes when configured)
 *
 * Usage:
 * - `/review` - show interactive selector
 * - `/review pr 123` - review PR #123 (checks out locally)
 * - `/review pr https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review https://github.com/owner/repo/pull/123` - review PR from URL
 * - `/review uncommitted` - review uncommitted changes directly
 * - `/review branch main` - review against main branch
 * - `/review commit abc123` - review specific commit
 * - `/review file src/index.ts` - review specific files (snapshot, not diff)
 * - `/review folder src docs` - review specific folders/files (snapshot, not diff)
 * - `/review` selector includes Add/Remove custom review instructions (applies to all modes)
 * - `/review --extra "focus on performance regressions"` - add extra review instruction (works with any mode)
 *
 * Project-specific review guidelines:
 * - If a REVIEW_GUIDELINES.md file exists in the same directory as .pi,
 *   its contents are appended to the review prompt.
 *
 * Note: PR review requires a clean working tree (no uncommitted changes to tracked files) and explicitly asks before changing the active checkout.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, type SelectItem, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

// State to track fresh session review (where we branched from).
// Module-level state means only one review can be active at a time.
// This is intentional - the UI and /end-review command assume a single active review.
let reviewOriginId: string | undefined;
let endReviewInProgress = false;
let reviewCustomInstructions: string | undefined;
let reviewCheckoutState: ReviewCheckoutState | undefined;

const REVIEW_STATE_TYPE = "review-session";
const REVIEW_ANCHOR_TYPE = "review-anchor";
const REVIEW_SETTINGS_TYPE = "review-settings";
const GH_SETUP_INSTRUCTIONS =
	"Install GitHub CLI (`gh`) from https://cli.github.com/ (macOS: `brew install gh`), then sign in with `gh auth login` and verify with `gh auth status`.";
const PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE =
	"Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.";

interface ReviewSessionState {
	active: boolean;
	originId?: string;
	checkout?: ReviewCheckoutState;
}

interface ReviewSettingsState {
	customInstructions?: string | undefined;
}

interface ReviewCheckoutState {
	originalBranch: string | null;
	originalHead: string;
	originalStatus: string;
	reviewBranch?: string | null;
	reviewHead?: string;
}

function setReviewWidget(ctx: ExtensionContext, active: boolean) {
	if (!ctx.hasUI) {
		return;
	}
	if (!active) {
		ctx.ui.setWidget("review", undefined);
		return;
	}

	ctx.ui.setWidget("review", (_tui, theme) => {
		const message = "Review session active, return with /end-review";
		const text = new Text(theme.fg("warning", message), 0, 0);
		return {
			render(width: number) {
				return text.render(width);
			},
			invalidate() {
				text.invalidate();
			},
		};
	});
}

function getReviewState(ctx: ExtensionContext): ReviewSessionState | undefined {
	let state: ReviewSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === REVIEW_STATE_TYPE) {
			state = entry.data as ReviewSessionState | undefined;
		}
	}

	return state;
}

function applyReviewState(ctx: ExtensionContext) {
	const state = getReviewState(ctx);

	if (state?.active && state.originId) {
		reviewOriginId = state.originId;
		reviewCheckoutState = state.checkout;
		setReviewWidget(ctx, true);
		return;
	}

	reviewOriginId = undefined;
	reviewCheckoutState = undefined;
	setReviewWidget(ctx, false);
}

function getReviewSettings(ctx: ExtensionContext): ReviewSettingsState {
	let state: ReviewSettingsState | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === REVIEW_SETTINGS_TYPE) {
			state = entry.data as ReviewSettingsState | undefined;
		}
	}

	return {
		customInstructions: state?.customInstructions?.trim() || undefined,
	};
}

function applyReviewSettings(ctx: ExtensionContext) {
	const state = getReviewSettings(ctx);
	reviewCustomInstructions = state.customInstructions?.trim() || undefined;
}

// Review target types (matching Codex's approach)
type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string; mergeBaseSha?: string }
	| { type: "commit"; sha: string; title?: string | undefined }
	| {
			type: "pullRequest";
			reference: string;
			prNumber: number;
			baseBranch: string;
			baseSha: string;
			headSha: string;
			title: string;
			mergeBaseSha?: string;
	  }
	| { type: "folder"; paths: string[] };

// Prompts (adapted from Codex)
const UNCOMMITTED_PROMPT =
	"Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

const BASE_BRANCH_PROMPT_WITH_MERGE_BASE =
	"Review the code changes against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes relative to {baseBranch}. Provide prioritized, actionable findings.";

const COMMIT_PROMPT_WITH_TITLE =
	'Review the code changes introduced by commit {sha} ("{title}"). Provide prioritized, actionable findings.';

const COMMIT_PROMPT = "Review the code changes introduced by commit {sha}. Provide prioritized, actionable findings.";

const PULL_REQUEST_PROMPT =
	"Review pull request #{prNumber} (\"{title}\") against the base branch '{baseBranch}'. The merge base commit for this comparison is {mergeBaseSha}. Run `git diff {mergeBaseSha}` to inspect the changes that would be merged. Provide prioritized, actionable findings.";

const FOLDER_REVIEW_PROMPT =
	"Review the code in the following paths: {paths}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.";

// The detailed review rubric (adapted from Codex's review_prompt.md)
const REVIEW_RUBRIC = `# Review Guidelines

You are acting as a code reviewer for a proposed code change made by another engineer.

Below are default guidelines for determining what to flag. These are not the final word — if you encounter more specific guidelines elsewhere (in a developer message, user message, file, or project review guidelines appended below), those override these general instructions.

## Determining what to flag

Flag issues that:
1. Meaningfully impact the accuracy, performance, security, or maintainability of the code.
2. Are discrete and actionable (not general issues or multiple combined issues).
3. Don't demand rigor inconsistent with the rest of the codebase.
4. Were introduced in the changes being reviewed (not pre-existing bugs).
5. The author would likely fix if aware of them.
6. Don't rely on unstated assumptions about the codebase or author's intent.
7. Have provable impact on other parts of the code — it is not enough to speculate that a change may disrupt another part, you must identify the parts that are provably affected.
8. Are clearly not intentional changes by the author.
9. Be particularly careful with untrusted user input and follow the specific guidelines to review.
10. Treat silent local error recovery (especially parsing/IO/network fallbacks) as high-signal review candidates unless there is explicit boundary-level justification.
11. Violate the clean-code guidelines below.
12. Introduce error handling that conflicts with the fail-fast guidelines below.

## Clean-code guidelines

1. Check whether each newly added function duplicates existing functionality elsewhere in the codebase. Flag actual duplication and identify the existing implementation.
2. Flag one-off helper functions that add indirection without improving clarity or reuse (for example, \`isRecord\` or \`asString\`).
3. Flag abstractions introduced without a concrete need in the reviewed change, including wrappers created only for hypothetical future use.
4. Flag defensive checks or fallback behavior that mask programming errors, especially when callers already guarantee the relevant invariants.

## Untrusted User Input

1. Be careful with open redirects, they must always be checked to only go to trusted domains (?next_page=...)
2. Always flag SQL that is not parametrized
3. In systems with user supplied URL input, http fetches always need to be protected against access to local resources (intercept DNS resolver!)
4. Escape, don't sanitize if you have the option (eg: HTML escaping)

## Comment guidelines

1. Be clear about why the issue is a problem.
2. Communicate severity appropriately - don't exaggerate.
3. Be brief - at most 1 paragraph.
4. Keep code snippets under 3 lines, wrapped in inline code or code blocks.
5. Use \`\`\`suggestion blocks ONLY for concrete replacement code (minimal lines; no commentary inside the block). Preserve the exact leading whitespace of the replaced lines.
6. Explicitly state scenarios/environments where the issue arises.
7. Use a matter-of-fact tone - helpful AI assistant, not accusatory.
8. Write for quick comprehension without close reading.
9. Avoid excessive flattery or unhelpful phrases like "Great job...".

## Review priorities

1. Surface critical non-blocking human callouts (migrations, dependency churn, auth/permissions, compatibility, destructive operations) at the end.
2. Prefer simple, direct solutions over wrappers or abstractions without clear value.
3. Treat back pressure handling as critical to system stability.
4. Apply system-level thinking; flag changes that increase operational risk or on-call wakeups.
5. Ensure that errors are always checked against codes or stable identifiers, never error messages.

## Fail-fast error handling (strict)

When reviewing added or modified error handling, default to fail-fast behavior.

1. Evaluate every new or changed \`try/catch\`: identify what can fail and why local handling is correct at that exact layer.
2. Prefer propagation over local recovery. If the current scope cannot fully recover while preserving correctness, rethrow (optionally with context) instead of returning fallbacks.
3. Flag catch blocks that hide failure signals (e.g. returning \`null\`/\`[]\`/\`false\`, swallowing JSON parse failures, logging-and-continue, or “best effort” silent recovery).
4. JSON parsing/decoding should fail loudly by default. Quiet fallback parsing is only acceptable with an explicit compatibility requirement and clear tested behavior.
5. Boundary handlers (HTTP routes, CLI entrypoints, supervisors) may translate errors, but must not pretend success or silently degrade.
6. If a catch exists only to satisfy lint/style without real handling, treat it as a bug.
7. When uncertain, prefer crashing fast over silent degradation.

## Required human callouts (non-blocking, at the very end)

After findings/verdict, you MUST append this final section:

## Human Reviewer Callouts (Non-Blocking)

Include only applicable callouts (no yes/no lines):

- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed> (call out re-use of dormant feature flags!)
- **This change changes configuration defaults:** <config var changed>

Rules for this section:
1. These are informational callouts for the human reviewer, not fix items.
2. Do not include them in Findings unless there is an independent defect.
3. These callouts alone must not change the verdict.
4. Only include callouts that apply to the reviewed change.
5. Keep each emitted callout bold exactly as written.
6. If none apply, write "- (none)".

## Priority levels

Tag each finding with a priority level in the title:
- [P0] - Drop everything to fix. Blocking release/operations. Only for universal issues that do not depend on assumptions about inputs.
- [P1] - Urgent. Should be addressed in the next cycle.
- [P2] - Normal. To be fixed eventually.
- [P3] - Low. Nice to have.

## Output format

Provide your findings in a clear, structured format:
1. List each finding with its priority tag, file location, and explanation.
2. Findings must reference locations that overlap with the actual diff — don't flag pre-existing code.
3. Keep line references as short as possible (avoid ranges over 5-10 lines; pick the most suitable subrange).
4. Provide an overall verdict: "correct" (no blocking issues) or "needs attention" (has blocking issues).
5. Ignore trivial style issues unless they obscure meaning or violate documented standards.
6. Do not generate a full PR fix — only flag issues and optionally provide short suggestion blocks.
7. End with the required "Human Reviewer Callouts (Non-Blocking)" section and all applicable bold callouts (no yes/no).

Output all findings the author would fix if they knew about them. If there are no qualifying findings, explicitly state the code looks good. Don't stop at the first finding - list every qualifying issue. Then append the required non-blocking callouts section.`;

const REVIEW_OUTPUT_CONTRACT = `Return only this structure:

## Review Summary
<one to four sentences describing the reviewed scope and overall result>

## Key Findings
- [P0|P1|P2|P3] <short title> — <path>:<line>
  - Evidence: <specific code, command output, or behavior>
  - Impact(s): <concrete consequence and affected scenario>
  - Suggested action(s): <small, actionable fix direction>

If there are no qualifying findings, write "- (none)" and state that the reviewed code looks good.
Do not report pre-existing issues or unsupported suspicions. Do not edit files, commit, push, or implement fixes during this review.

## Human Reviewer Callouts (Non-Blocking)
Include only applicable items, preserving the bold labels:
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed>
- **This change changes configuration defaults:** <config var changed>
- **This change changes observability behavior:** <logging, metrics, or tracing details>
- **This change creates rollout or rollback concerns:** <operational concern>
If none apply, write "- (none)".

## Verdict
<correct|needs attention>

Use exact paths, short line ranges, and one of [P0], [P1], [P2], or [P3] for each finding.`;

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadProjectReviewGuidelines(cwd: string): Promise<string | null> {
	let currentDir = path.resolve(cwd);

	while (true) {
		const piDir = path.join(currentDir, ".pi");
		const guidelinesPath = path.join(currentDir, "REVIEW_GUIDELINES.md");

		let piStats;
		try {
			piStats = await fs.stat(piDir);
		} catch (error) {
			if (!isMissingPathError(error)) {
				throw error;
			}
		}

		if (piStats?.isDirectory()) {
			let guidelineStats;
			try {
				guidelineStats = await fs.stat(guidelinesPath);
			} catch (error) {
				if (!isMissingPathError(error)) {
					throw error;
				}
			}
			if (guidelineStats?.isFile()) {
				const content = await fs.readFile(guidelinesPath, "utf8");
				const trimmed = content.trim();
				return trimmed ? trimmed : null;
			}
			return null;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/**
 * Get the merge base between HEAD and a branch
 */
async function getMergeBase(pi: ExtensionAPI, branch: string): Promise<string> {
	// Prefer the upstream ref when one exists, matching the branch users merge from.
	const { stdout: upstream } = await pi.exec("git", ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
	const upstreamRef = upstream.trim();
	const comparisonRef = upstreamRef || branch;
	const { stdout: mergeBase, stderr, code } = await pi.exec("git", ["merge-base", "HEAD", comparisonRef]);
	if (code !== 0 || !mergeBase.trim()) {
		throw new Error(`Unable to resolve the merge base for '${branch}': ${stderr.trim() || "git merge-base failed"}`);
	}
	return mergeBase.trim();
}

/**
 * Get list of local branches
 */
async function getLocalBranches(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, stderr, code } = await pi.exec("git", ["branch", "--format=%(refname:short)"]);
	if (code !== 0) {
		throw new Error(`Unable to list local branches: ${stderr.trim() || "git branch failed"}`);
	}
	return stdout
		.trim()
		.split("\n")
		.filter((b) => b.trim());
}

/**
 * Get list of recent commits
 */
async function getRecentCommits(pi: ExtensionAPI, limit = 10): Promise<Array<{ sha: string; title: string }>> {
	const { stdout, stderr, code } = await pi.exec("git", ["log", "--oneline", "-n", `${limit}`]);
	if (code !== 0) {
		throw new Error(`Unable to list recent commits: ${stderr.trim() || "git log failed"}`);
	}

	return stdout
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			const [sha, ...rest] = line.trim().split(" ");
			return sha === undefined ? [] : [{ sha, title: rest.join(" ") }];
		});
}

type ReviewSelectorItem = SelectItem;

function filterReviewSelectorItems(items: readonly ReviewSelectorItem[], query: string): ReviewSelectorItem[] {
	const normalizedQuery = query.trim();
	if (normalizedQuery.length === 0) {
		return [...items];
	}
	return fuzzyFilter([...items], normalizedQuery, (item) => `${item.label} ${item.value} ${item.description ?? ""}`);
}

function sortReviewBranches(
	branches: readonly string[],
	currentBranch: string | null,
	defaultBranch: string,
): string[] {
	return branches
		.filter((branch) => branch !== currentBranch)
		.sort((left, right) => {
			if (left === defaultBranch) {
				return -1;
			}
			if (right === defaultBranch) {
				return 1;
			}
			return left.localeCompare(right);
		});
}

function createBranchSelectorItems(branches: readonly string[], defaultBranch: string): ReviewSelectorItem[] {
	return branches.map((branch) => ({
		value: branch,
		label: branch,
		description: branch === defaultBranch ? "(default)" : "",
	}));
}

function createCommitSelectorItems(commits: readonly { sha: string; title: string }[]): ReviewSelectorItem[] {
	return commits.map((commit) => ({
		value: commit.sha,
		label: `${commit.sha.slice(0, 7)} ${commit.title}`,
		description: "",
	}));
}

type ReviewSelectorConfig<T> = Readonly<{
	title: string;
	emptyMessage: string;
	noMatchMessage: string;
	items: readonly ReviewSelectorItem[];
	mapSelection: (item: ReviewSelectorItem) => T | null;
}>;

// The branch and commit selectors intentionally share this one TUI lifecycle:
// keeping filtering, keybindings, cancellation, and selection rendering in one
// place prevents the two review targets from drifting behaviorally.
async function showReviewSelectorList<T>(ctx: ExtensionContext, config: ReviewSelectorConfig<T>): Promise<T | null> {
	if (config.items.length === 0) {
		ctx.ui.notify(config.emptyMessage, "error");
		return null;
	}
	return ctx.ui.custom<T | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		container.addChild(new Text(theme.fg("accent", theme.bold(config.title))));
		const searchInput = new Input();
		container.addChild(searchInput);
		container.addChild(new Spacer(1));
		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		let filteredItems = [...config.items];
		let selectList: SelectList | null = null;
		const updateList = () => {
			listContainer.clear();
			if (filteredItems.length === 0) {
				listContainer.addChild(new Text(theme.fg("warning", `  ${config.noMatchMessage}`)));
				selectList = null;
				return;
			}
			selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(config.mapSelection(item));
			selectList.onCancel = () => done(null);
			listContainer.addChild(selectList);
		};
		const applyFilter = () => {
			filteredItems = filterReviewSelectorItems(config.items, searchInput.getValue());
			updateList();
		};
		applyFilter();
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					selectList !== null &&
					(keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel"))
				) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				if (selectList === null && keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				}
				searchInput.handleInput(data);
				applyFilter();
				tui.requestRender();
			},
		};
	});
}

/**
 * Check if there are uncommitted changes (staged, unstaged, or untracked)
 */
async function getWorkingTreeStatus(pi: ExtensionAPI): Promise<string> {
	const { stdout, stderr, code } = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"]);
	if (code !== 0) {
		throw new Error(`Unable to inspect working tree: ${stderr.trim() || "git status failed"}`);
	}
	return stdout;
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
	return (await getWorkingTreeStatus(pi)).trim().length > 0;
}

/**
 * Check if there are changes that would prevent switching branches
 * (staged or unstaged changes to tracked files - untracked files are fine)
 */
async function hasPendingChanges(pi: ExtensionAPI): Promise<boolean> {
	// Untracked files are allowed by the review workflow, but tracked changes are not.
	const lines = (await getWorkingTreeStatus(pi)).split("\n").filter((line) => line.trim());
	return lines.some((line) => !line.startsWith("??"));
}

interface GitHubPullRequestInfo {
	prNumber: number;
	baseBranch: string;
	baseSha: string;
	headSha: string;
	baseRepository: string;
	title: string;
	headBranch: string;
}

/**
 * Parse and validate a GitHub PR reference without discarding its repository.
 */
function parsePrReference(ref: string): string | null {
	const trimmed = ref.trim();
	if (/^[1-9][0-9]*$/.test(trimmed)) {
		return trimmed;
	}

	const urlValue = trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
	try {
		const url = new URL(urlValue);
		if (url.protocol !== "https:" || url.hostname !== "github.com") {
			return null;
		}
		if (!/^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*\/?$/.test(url.pathname)) {
			return null;
		}
		return trimmed;
	} catch {
		return null;
	}
}

/**
 * Get PR information from GitHub CLI.
 */
async function getPrInfo(pi: ExtensionAPI, reference: string): Promise<GitHubPullRequestInfo> {
	const { stdout, stderr, code } = await pi.exec("gh", [
		"pr",
		"view",
		reference,
		"--json",
		"number,baseRefName,baseRefOid,baseRepository,title,headRefName,headRefOid",
	]);
	if (code !== 0) {
		throw new Error(`Unable to fetch pull request '${reference}': ${stderr.trim() || "gh pr view failed"}`);
	}

	const data: unknown = JSON.parse(stdout);
	if (typeof data !== "object" || data === null) {
		throw new Error(`GitHub returned an invalid pull request for '${reference}'`);
	}
	const record = data as Record<string, unknown>;
	const baseRepository = record["baseRepository"];
	const baseRepositoryName =
		typeof baseRepository === "object" && baseRepository !== null
			? (baseRepository as Record<string, unknown>)["nameWithOwner"]
			: undefined;
	if (
		typeof record["number"] !== "number" ||
		typeof record["baseRefName"] !== "string" ||
		typeof record["baseRefOid"] !== "string" ||
		typeof baseRepositoryName !== "string" ||
		typeof record["title"] !== "string" ||
		typeof record["headRefName"] !== "string" ||
		typeof record["headRefOid"] !== "string"
	) {
		throw new Error(`GitHub returned incomplete pull request data for '${reference}'`);
	}
	return {
		prNumber: record["number"],
		baseBranch: record["baseRefName"],
		baseSha: record["baseRefOid"],
		headSha: record["headRefOid"],
		baseRepository: baseRepositoryName,
		title: record["title"],
		headBranch: record["headRefName"],
	};
}

/**
 * Checkout a PR using GitHub CLI.
 */
async function getCurrentRepository(pi: ExtensionAPI): Promise<string> {
	const { stdout, stderr, code } = await pi.exec("gh", [
		"repo",
		"view",
		"--json",
		"nameWithOwner",
		"--jq",
		".nameWithOwner",
	]);
	if (code !== 0 || !stdout.trim()) {
		throw new Error(`Unable to determine the current GitHub repository: ${stderr.trim() || "gh repo view failed"}`);
	}
	return stdout.trim();
}

function repositoryFromPrReference(reference: string): string | undefined {
	if (/^[1-9][0-9]*$/.test(reference)) {
		return;
	}
	const urlValue = reference.startsWith("https://") ? reference : `https://${reference}`;
	const url = new URL(urlValue);
	const parts = url.pathname.split("/").filter((part) => part.length > 0);
	if (parts.length < 4) {
		return;
	}
	return `${parts[0]}/${parts[1]}`;
}

async function checkoutPr(pi: ExtensionAPI, reference: string): Promise<void> {
	const { stdout, stderr, code } = await pi.exec("gh", ["pr", "checkout", reference]);
	if (code !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || "Failed to checkout PR");
	}
}

/**
 * Get the current branch name
 */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, stderr, code } = await pi.exec("git", ["branch", "--show-current"]);
	if (code !== 0) {
		throw new Error(`Unable to determine current branch: ${stderr.trim() || "git branch failed"}`);
	}
	return stdout.trim() || null;
}

async function getHeadSha(pi: ExtensionAPI): Promise<string> {
	const { stdout, stderr, code } = await pi.exec("git", ["rev-parse", "HEAD"]);
	if (code !== 0 || !stdout.trim()) {
		throw new Error(`Unable to determine current commit: ${stderr.trim() || "git rev-parse failed"}`);
	}
	return stdout.trim();
}

/**
 * Get the default branch (main or master)
 */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	// Try to get from remote HEAD
	const { stdout, code } = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	// Fall back to checking if main or master exists
	const branches = await getLocalBranches(pi);
	if (branches.includes("main")) {
		return "main";
	}
	if (branches.includes("master")) {
		return "master";
	}

	return "main"; // Default fallback
}

async function resolveReviewPaths(cwd: string, paths: string[]): Promise<string[]> {
	const root = await fs.realpath(cwd);
	const resolvedPaths: string[] = [];
	for (const reviewPath of paths) {
		const resolved = await fs.realpath(path.resolve(root, reviewPath));
		const relative = path.relative(root, resolved);
		if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
			throw new Error(`Review path '${reviewPath}' is outside the repository root`);
		}
		resolvedPaths.push(relative || ".");
	}
	return [...new Set(resolvedPaths)];
}

async function resolveReviewTarget(pi: ExtensionAPI, cwd: string, target: ReviewTarget): Promise<ReviewTarget> {
	switch (target.type) {
		case "uncommitted":
			return target;
		case "baseBranch":
			return { ...target, mergeBaseSha: await getMergeBase(pi, target.branch) };
		case "commit": {
			const { stdout, stderr, code } = await pi.exec("git", ["rev-parse", "--verify", `${target.sha}^{commit}`]);
			if (code !== 0 || !stdout.trim()) {
				throw new Error(`Unable to resolve commit '${target.sha}': ${stderr.trim() || "git rev-parse failed"}`);
			}
			return { ...target, sha: stdout.trim() };
		}
		case "pullRequest": {
			let baseResolution = await pi.exec("git", ["rev-parse", "--verify", `${target.baseSha}^{commit}`]);
			if (baseResolution.code !== 0 || !baseResolution.stdout.trim()) {
				const baseFetch = await pi.exec("git", ["fetch", "--no-tags", "origin", `refs/heads/${target.baseBranch}`]);
				if (baseFetch.code !== 0) {
					throw new Error(
						`Unable to fetch authoritative Pull Request base ${target.baseSha}: ${baseFetch.stderr.trim() || "git fetch failed"}`,
					);
				}
				baseResolution = await pi.exec("git", ["rev-parse", "--verify", `${target.baseSha}^{commit}`]);
			}
			if (baseResolution.code !== 0 || !baseResolution.stdout.trim()) {
				throw new Error(
					`Unable to resolve authoritative Pull Request base ${target.baseSha}: ${baseResolution.stderr.trim() || "git rev-parse failed"}`,
				);
			}
			const headResolution = await pi.exec("git", ["rev-parse", "--verify", `${target.headSha}^{commit}`]);
			if (headResolution.code !== 0 || !headResolution.stdout.trim()) {
				throw new Error(
					`Unable to resolve authoritative Pull Request head ${target.headSha}: ${headResolution.stderr.trim() || "git rev-parse failed"}`,
				);
			}
			const { stdout: mergeBase, stderr, code } = await pi.exec("git", ["merge-base", target.headSha, target.baseSha]);
			if (code !== 0 || !mergeBase.trim()) {
				throw new Error(`Unable to resolve the Pull Request merge base: ${stderr.trim() || "git merge-base failed"}`);
			}
			return { ...target, mergeBaseSha: mergeBase.trim() };
		}
		case "folder":
			return { ...target, paths: await resolveReviewPaths(cwd, target.paths) };
	}
}

/**
 * Build the review prompt from a resolved, immutable target.
 */
function buildReviewPrompt(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return UNCOMMITTED_PROMPT;
		case "baseBranch":
			if (!target.mergeBaseSha) {
				throw new Error("Review target has no resolved merge base");
			}
			return BASE_BRANCH_PROMPT_WITH_MERGE_BASE.replace(/{baseBranch}/g, target.branch).replace(
				/{mergeBaseSha}/g,
				target.mergeBaseSha,
			);
		case "commit":
			return target.title
				? COMMIT_PROMPT_WITH_TITLE.replace("{sha}", target.sha).replace("{title}", target.title)
				: COMMIT_PROMPT.replace("{sha}", target.sha);
		case "pullRequest":
			if (!target.mergeBaseSha) {
				throw new Error("Review target has no resolved merge base");
			}
			return PULL_REQUEST_PROMPT.replace(/{prNumber}/g, String(target.prNumber))
				.replace(/{title}/g, target.title)
				.replace(/{baseBranch}/g, target.baseBranch)
				.replace(/{mergeBaseSha}/g, target.mergeBaseSha);
		case "folder":
			return FOLDER_REVIEW_PROMPT.replace("{paths}", target.paths.join(", "));
	}
}

/**
 * Get user-facing hint for the review target
 */
function getUserFacingHint(target: ReviewTarget): string {
	switch (target.type) {
		case "uncommitted":
			return "current changes";
		case "baseBranch":
			return `changes against '${target.branch}'`;
		case "commit": {
			const shortSha = target.sha.slice(0, 7);
			return target.title ? `commit ${shortSha}: ${target.title}` : `commit ${shortSha}`;
		}

		case "pullRequest": {
			const shortTitle = target.title.length > 30 ? `${target.title.slice(0, 27)}...` : target.title;
			return `PR #${target.prNumber}: ${shortTitle}`;
		}

		case "folder": {
			const joined = target.paths.join(", ");
			return joined.length > 40 ? `folders: ${joined.slice(0, 37)}...` : `folders: ${joined}`;
		}
	}
}

// Review preset options for the selector (keep this order stable)
const REVIEW_PRESETS = [
	{ value: "uncommitted", label: "Review uncommitted changes", description: "" },
	{ value: "baseBranch", label: "Review against a base branch", description: "(local)" },
	{ value: "commit", label: "Review a commit", description: "" },
	{ value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
	{ value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
] as const;

const TOGGLE_CUSTOM_INSTRUCTIONS_VALUE = "toggleCustomInstructions" as const;
type ReviewPresetValue = (typeof REVIEW_PRESETS)[number]["value"] | typeof TOGGLE_CUSTOM_INSTRUCTIONS_VALUE;

export default function reviewExtension(pi: ExtensionAPI) {
	function persistReviewSettings() {
		pi.appendEntry(REVIEW_SETTINGS_TYPE, {
			customInstructions: reviewCustomInstructions,
		});
	}

	function setReviewCustomInstructions(instructions: string | undefined) {
		reviewCustomInstructions = instructions?.trim() || undefined;
		persistReviewSettings();
	}

	function applyAllReviewState(ctx: ExtensionContext) {
		applyReviewSettings(ctx);
		applyReviewState(ctx);
	}

	async function ensureGithubCliReady(ctx: ExtensionContext): Promise<boolean> {
		const ghVersion = await pi.exec("gh", ["--version"]);
		if (ghVersion.code !== 0) {
			ctx.ui.notify(`PR review requires GitHub CLI (\`gh\`). ${GH_SETUP_INSTRUCTIONS}`, "error");
			return false;
		}

		const ghAuthStatus = await pi.exec("gh", ["auth", "status"]);
		if (ghAuthStatus.code !== 0) {
			ctx.ui.notify(
				"GitHub CLI is installed, but you're not signed in. Run `gh auth login`, then verify with `gh auth status`.",
				"error",
			);
			return false;
		}

		return true;
	}

	async function resolvePullRequestTarget(
		ctx: ExtensionContext,
		ref: string,
		options: { skipInitialPendingChangesCheck?: boolean } = {},
	): Promise<ReviewTarget | null> {
		if (!(await ensureGithubCliReady(ctx))) {
			return null;
		}
		if (!options.skipInitialPendingChangesCheck && (await hasPendingChanges(pi))) {
			ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		const reference = parsePrReference(ref);
		if (!reference) {
			ctx.ui.notify("Invalid PR reference. Enter a number or an HTTPS GitHub PR URL.", "error");
			return null;
		}

		let prInfo: GitHubPullRequestInfo;
		try {
			ctx.ui.notify(`Fetching pull request ${reference} info...`, "info");
			prInfo = await getPrInfo(pi, reference);
			const currentRepository = await getCurrentRepository(pi);
			const referencedRepository = repositoryFromPrReference(reference);
			if (
				referencedRepository !== undefined &&
				referencedRepository.toLowerCase() !== currentRepository.toLowerCase()
			) {
				throw new Error(
					`Pull Request repository '${referencedRepository}' does not match the current repository '${currentRepository}'.`,
				);
			}
			if (prInfo.baseRepository.toLowerCase() !== currentRepository.toLowerCase()) {
				throw new Error(
					`Pull Request base repository '${prInfo.baseRepository}' does not match the current repository '${currentRepository}'.`,
				);
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return null;
		}

		// Re-check immediately before checkout. Untracked files are preserved and tracked edits are blocked.
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		const shouldCheckout = await ctx.ui.confirm(
			`Checkout pull request #${prInfo.prNumber}?`,
			`This changes the active worktree to ${prInfo.headBranch}. Choose No to cancel without changing branches.`,
		);
		if (!shouldCheckout) {
			ctx.ui.notify("PR checkout cancelled; the active branch was not changed.", "info");
			return null;
		}

		const originalBranch = await getCurrentBranch(pi);
		const originalHead = await getHeadSha(pi);
		const originalStatus = await getWorkingTreeStatus(pi);

		try {
			ctx.ui.notify(`Checking out PR #${prInfo.prNumber}...`, "info");
			await checkoutPr(pi, reference);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return null;
		}

		const reviewBranch = await getCurrentBranch(pi);
		const reviewHead = await getHeadSha(pi);
		reviewCheckoutState = { originalBranch, originalHead, originalStatus, reviewBranch, reviewHead };
		if (reviewHead !== prInfo.headSha) {
			let restored = false;
			let restoreError: string | undefined;
			try {
				restored = await restoreReviewCheckout(ctx);
			} catch (error) {
				restoreError = error instanceof Error ? error.message : String(error);
			}
			let message = `Checked out PR head ${reviewHead} does not match GitHub head ${prInfo.headSha}.`;
			if (!restored) {
				message += " Restore the original checkout manually before continuing.";
			}
			if (restoreError !== undefined) {
				message += ` Automatic restoration failed: ${restoreError}`;
			}
			ctx.ui.notify(message, "error");
			return null;
		}
		ctx.ui.notify(`Checked out PR #${prInfo.prNumber} (${prInfo.headBranch})`, "info");
		return {
			type: "pullRequest",
			reference,
			prNumber: prInfo.prNumber,
			baseBranch: prInfo.baseBranch,
			baseSha: prInfo.baseSha,
			headSha: prInfo.headSha,
			title: prInfo.title,
		};
	}

	async function restoreReviewCheckout(ctx: ExtensionContext): Promise<boolean> {
		const checkout = reviewCheckoutState;
		if (!checkout) {
			return true;
		}

		const currentStatus = await getWorkingTreeStatus(pi);
		if (currentStatus !== checkout.originalStatus) {
			ctx.ui.notify("PR checkout was not restored because the working tree changed during review.", "error");
			return false;
		}
		if (checkout.reviewHead !== undefined) {
			const currentHead = await getHeadSha(pi);
			if (currentHead !== checkout.reviewHead) {
				ctx.ui.notify("PR checkout was not restored because the checkout changed during review.", "error");
				return false;
			}
		}

		const args = checkout.originalBranch
			? ["switch", checkout.originalBranch]
			: ["switch", "--detach", checkout.originalHead];
		const result = await pi.exec("git", args);
		if (result.code !== 0) {
			ctx.ui.notify(`Failed to restore the original checkout: ${result.stderr.trim() || "git switch failed"}`, "error");
			return false;
		}
		reviewCheckoutState = undefined;
		return true;
	}

	pi.on("session_start", (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		applyAllReviewState(ctx);
	});

	/**
	 * Determine the smart default review type based on git state
	 */
	async function getSmartDefault(): Promise<"uncommitted" | "baseBranch" | "commit"> {
		// Priority 1: If there are uncommitted changes, default to reviewing them
		if (await hasUncommittedChanges(pi)) {
			return "uncommitted";
		}

		// Priority 2: If on a feature branch (not the default branch), default to PR-style review
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		if (currentBranch && currentBranch !== defaultBranch) {
			return "baseBranch";
		}

		// Priority 3: Default to reviewing a specific commit
		return "commit";
	}

	/**
	 * Show the review preset selector
	 */
	async function showReviewSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// Determine smart default (but keep the list order stable)
		const smartDefault = await getSmartDefault();
		const presetItems: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
			value: preset.value,
			label: preset.label,
			description: preset.description,
		}));
		const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

		while (true) {
			const customInstructionsLabel = reviewCustomInstructions
				? "Remove custom review instructions"
				: "Add custom review instructions";
			const customInstructionsDescription = reviewCustomInstructions
				? "(currently set)"
				: "(applies to all review modes)";
			const items: SelectItem[] = [
				...presetItems,
				{
					value: TOGGLE_CUSTOM_INSTRUCTIONS_VALUE,
					label: customInstructionsLabel,
					description: customInstructionsDescription,
				},
			];

			const result = await ctx.ui.custom<ReviewPresetValue | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Select a review preset"))));

				const selectList = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});

				// Preselect the smart default without reordering the list
				if (smartDefaultIndex >= 0) {
					selectList.setSelectedIndex(smartDefaultIndex);
				}

				selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
				selectList.onCancel = () => done(null);

				container.addChild(selectList);
				container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to go back")));
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (!result) {
				return null;
			}

			if (result === TOGGLE_CUSTOM_INSTRUCTIONS_VALUE) {
				if (reviewCustomInstructions) {
					setReviewCustomInstructions(undefined);
					ctx.ui.notify("Custom review instructions removed", "info");
					continue;
				}

				const customInstructions = await ctx.ui.editor(
					"Enter custom review instructions (applies to all review modes):",
					"",
				);

				if (!customInstructions?.trim()) {
					ctx.ui.notify("Custom review instructions not changed", "info");
					continue;
				}

				setReviewCustomInstructions(customInstructions);
				ctx.ui.notify("Custom review instructions saved", "info");
				continue;
			}

			// Handle each preset type
			switch (result) {
				case "uncommitted":
					return { type: "uncommitted" };

				case "baseBranch": {
					const target = await showBranchSelector(ctx);
					if (target) {
						return target;
					}
					break;
				}

				case "commit": {
					const target = await showCommitSelector(ctx);
					if (target) {
						return target;
					}
					break;
				}

				case "folder": {
					const target = await showFolderInput(ctx);
					if (target) {
						return target;
					}
					break;
				}

				case "pullRequest": {
					const target = await showPrInput(ctx);
					if (target) {
						return target;
					}
					break;
				}

				default:
					return null;
			}
		}
	}

	/** Show branch selector for base branch review. */
	async function showBranchSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const branches = await getLocalBranches(pi);
		const currentBranch = await getCurrentBranch(pi);
		const defaultBranch = await getDefaultBranch(pi);
		const candidateBranches = sortReviewBranches(branches, currentBranch, defaultBranch);
		if (candidateBranches.length === 0) {
			ctx.ui.notify(
				currentBranch ? `No other branches found (current branch: ${currentBranch})` : "No branches found",
				"error",
			);
			return null;
		}
		const selected = await showReviewSelectorList(ctx, {
			title: "Select base branch",
			emptyMessage: "No branches found",
			noMatchMessage: "No matching branches",
			items: createBranchSelectorItems(candidateBranches, defaultBranch),
			mapSelection: (item) => item.value,
		});
		if (selected === null) return null;
		return { type: "baseBranch", branch: selected };
	}

	/** Show commit selector. */
	async function showCommitSelector(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const commits = await getRecentCommits(pi, 20);
		const selected = await showReviewSelectorList(ctx, {
			title: "Select commit to review",
			emptyMessage: "No commits found",
			noMatchMessage: "No matching commits",
			items: createCommitSelectorItems(commits),
			mapSelection: (item) => commits.find((commit) => commit.sha === item.value) ?? null,
		});
		if (selected === null) return null;
		return { type: "commit", sha: selected.sha, title: selected.title };
	}

	function parseReviewPaths(value: string): string[] {
		return value
			.split(/\s+/)
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}

	/**
	 * Show folder input
	 */
	async function showFolderInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		const result = await ctx.ui.editor("Enter folders/files to review (space-separated or one per line):", ".");

		if (!result?.trim()) {
			return null;
		}
		const paths = parseReviewPaths(result);
		if (paths.length === 0) {
			return null;
		}

		return { type: "folder", paths };
	}

	/**
	 * Show PR input and handle checkout
	 */
	async function showPrInput(ctx: ExtensionContext): Promise<ReviewTarget | null> {
		// First check for pending changes that would prevent branch switching
		if (await hasPendingChanges(pi)) {
			ctx.ui.notify(PR_CHECKOUT_BLOCKED_BY_PENDING_CHANGES_MESSAGE, "error");
			return null;
		}

		// Get PR reference from user
		const prRef = await ctx.ui.editor(
			"Enter PR number or URL (e.g. 123 or https://github.com/owner/repo/pull/123):",
			"",
		);

		if (!prRef?.trim()) {
			return null;
		}

		return await resolvePullRequestTarget(ctx, prRef, { skipInitialPendingChangesCheck: true });
	}

	/**
	 * Execute the review
	 */
	async function executeReview(
		ctx: ExtensionCommandContext,
		target: ReviewTarget,
		useFreshSession: boolean,
		options?: { extraInstruction?: string | undefined },
	): Promise<boolean> {
		// Check if we're already in a review
		if (reviewOriginId) {
			ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
			return false;
		}

		let resolvedTarget: ReviewTarget;
		try {
			resolvedTarget = await resolveReviewTarget(pi, ctx.cwd, target);
		} catch (error) {
			await restoreReviewCheckout(ctx);
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return false;
		}
		// A PR checkout changes the worktree, so always give it a returnable review branch.
		if (resolvedTarget.type === "pullRequest" && !useFreshSession) {
			ctx.ui.notify("PR reviews use a returnable review branch so the original checkout can be restored.", "info");
			useFreshSession = true;
		}

		// Handle fresh session mode
		if (useFreshSession) {
			// Store current position (where we'll return to).
			// In an empty session there is no leaf yet, so create a lightweight anchor first.
			let originId = ctx.sessionManager.getLeafId() ?? undefined;
			if (!originId) {
				pi.appendEntry(REVIEW_ANCHOR_TYPE, { createdAt: new Date().toISOString() });
				originId = ctx.sessionManager.getLeafId() ?? undefined;
			}
			if (!originId) {
				ctx.ui.notify("Failed to determine review origin.", "error");
				return false;
			}
			reviewOriginId = originId;

			// Keep local copies so session_tree events during navigation don't wipe review state.
			const lockedOriginId = originId;
			const lockedCheckoutState = reviewCheckoutState;

			// Find the first user message in the session.
			// If none exists (e.g. brand-new session), we'll stay on the current leaf.
			const entries = ctx.sessionManager.getEntries();
			const firstUserMessage = entries.find((e) => e.type === "message" && e.message.role === "user");

			if (firstUserMessage) {
				// Navigate to first user message to create a new branch from that point
				// Label it as "code-review" so it's visible in the tree
				try {
					const result = await ctx.navigateTree(firstUserMessage.id, { summarize: false, label: "code-review" });
					if (result.cancelled) {
						reviewOriginId = undefined;
						reviewCheckoutState = lockedCheckoutState;
						await restoreReviewCheckout(ctx);
						return false;
					}
				} catch (error) {
					// Clean up state if navigation fails
					reviewOriginId = undefined;
					reviewCheckoutState = lockedCheckoutState;
					await restoreReviewCheckout(ctx);
					ctx.ui.notify(`Failed to start review: ${error instanceof Error ? error.message : String(error)}`, "error");
					return false;
				}

				// Clear the editor (navigating to user message fills it with the message text)
				ctx.ui.setEditorText("");
			}

			// Restore state after navigation events (session_tree can reset it)
			reviewOriginId = lockedOriginId;
			reviewCheckoutState = lockedCheckoutState;

			// Show widget indicating review is active
			setReviewWidget(ctx, true);

			// Persist review state so tree navigation can restore/reset it.
			if (reviewCheckoutState) {
				pi.appendEntry(REVIEW_STATE_TYPE, {
					active: true,
					originId: lockedOriginId,
					checkout: reviewCheckoutState,
				});
			} else {
				pi.appendEntry(REVIEW_STATE_TYPE, { active: true, originId: lockedOriginId });
			}
		}

		const prompt = buildReviewPrompt(resolvedTarget);
		const hint = getUserFacingHint(resolvedTarget);
		const projectGuidelines = await loadProjectReviewGuidelines(ctx.cwd);

		// Combine the review rubric with the specific prompt
		let fullPrompt = `${REVIEW_RUBRIC}\n\n---\n\nPlease perform a code review with the following focus:\n\n${prompt}`;

		if (reviewCustomInstructions) {
			fullPrompt += `\n\nShared custom review instructions (applies to all reviews):\n\n${reviewCustomInstructions}`;
		}

		if (options?.extraInstruction?.trim()) {
			fullPrompt += `\n\nAdditional user-provided review instruction:\n\n${options.extraInstruction.trim()}`;
		}

		if (projectGuidelines) {
			fullPrompt += `\n\nThis project has additional instructions for code reviews:\n\n${projectGuidelines}`;
		}
		fullPrompt += `\n\n${REVIEW_OUTPUT_CONTRACT}`;

		const modeHint = useFreshSession ? " (fresh session)" : "";
		ctx.ui.notify(`Starting review: ${hint}${modeHint}`, "info");

		// Send as a user message that triggers a turn
		pi.sendUserMessage(fullPrompt);
		return true;
	}

	/**
	 * Parse command arguments for direct invocation
	 * Returns the target or a special marker for PR that needs async handling
	 */
	interface ParsedReviewArgs {
		target: ReviewTarget | { type: "pr"; ref: string } | null;
		extraInstruction?: string | undefined;
		error?: string;
	}

	function tokenizeArgs(value: string): string[] {
		const tokens: string[] = [];
		let current = "";
		let quote: '"' | "'" | null = null;

		for (let i = 0; i < value.length; i++) {
			const char = value[i];
			if (char === undefined) {
				continue;
			}

			if (quote) {
				if (char === "\\" && i + 1 < value.length) {
					current += value[i + 1];
					i += 1;
					continue;
				}
				if (char === quote) {
					quote = null;
					continue;
				}
				current += char;
				continue;
			}

			if (char === '"' || char === "'") {
				quote = char;
				continue;
			}

			if (/\s/.test(char)) {
				if (current.length > 0) {
					tokens.push(current);
					current = "";
				}
				continue;
			}

			current += char;
		}

		if (current.length > 0) {
			tokens.push(current);
		}

		return tokens;
	}

	function parseArgs(args: string | undefined): ParsedReviewArgs {
		if (!args?.trim()) {
			return { target: null };
		}

		const rawParts = tokenizeArgs(args.trim());
		const parts: string[] = [];
		let extraInstruction: string | undefined;

		for (let i = 0; i < rawParts.length; i++) {
			const part = rawParts[i];
			if (part === undefined) {
				continue;
			}
			if (part === "--extra") {
				const next = rawParts[i + 1];
				if (!next) {
					return { target: null, error: "Missing value for --extra" };
				}
				extraInstruction = next;
				i += 1;
				continue;
			}

			if (part.startsWith("--extra=")) {
				extraInstruction = part.slice("--extra=".length);
				continue;
			}

			parts.push(part);
		}

		if (parts.length === 0) {
			return { target: null, extraInstruction };
		}

		const subcommand = parts[0]?.toLowerCase();
		const directPrReference = parts.length === 1 && parts[0] ? parsePrReference(parts[0]) : null;
		if (directPrReference) {
			return { target: { type: "pr", ref: directPrReference }, extraInstruction };
		}

		switch (subcommand) {
			case "uncommitted":
				return { target: { type: "uncommitted" }, extraInstruction };

			case "branch": {
				const branch = parts[1];
				if (!branch) {
					return { target: null, extraInstruction };
				}
				return { target: { type: "baseBranch", branch }, extraInstruction };
			}

			case "commit": {
				const sha = parts[1];
				if (!sha) {
					return { target: null, extraInstruction };
				}
				const title = parts.slice(2).join(" ") || undefined;
				return { target: { type: "commit", sha, title }, extraInstruction };
			}

			case "file":
			case "folder": {
				const paths = parts.slice(1);
				if (paths.length === 0) {
					return { target: null, extraInstruction };
				}
				return { target: { type: "folder", paths }, extraInstruction };
			}

			case "pr": {
				const ref = parts[1];
				if (!ref) {
					return { target: null, extraInstruction };
				}
				return { target: { type: "pr", ref }, extraInstruction };
			}

			default:
				return { target: { type: "folder", paths: parts }, extraInstruction };
		}
	}

	/**
	 * Handle PR checkout and return a ReviewTarget (or null on failure)
	 */
	async function handlePrCheckout(ctx: ExtensionContext, ref: string): Promise<ReviewTarget | null> {
		return await resolvePullRequestTarget(ctx, ref);
	}

	// Register the /review command
	pi.registerCommand("review", {
		description: "Review code changes (PR, uncommitted, branch, commit, or folder)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Review requires interactive mode", "error");
				return;
			}

			// Check if we're already in a review
			if (reviewOriginId) {
				ctx.ui.notify("Already in a review. Use /end-review to finish first.", "warning");
				return;
			}

			// Check if we're in a git repository
			const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (code !== 0) {
				ctx.ui.notify("Not a git repository", "error");
				return;
			}

			// Try to parse direct arguments
			let target: ReviewTarget | null = null;
			let fromSelector = false;
			let extraInstruction: string | undefined;
			const parsed = parseArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "error");
				return;
			}
			extraInstruction = parsed.extraInstruction?.trim() || undefined;

			if (parsed.target) {
				if (parsed.target.type === "pr") {
					// Handle PR checkout (async operation)
					target = await handlePrCheckout(ctx, parsed.target.ref);
					if (!target) {
						ctx.ui.notify("PR review failed. Returning to review menu.", "warning");
					}
				} else {
					target = parsed.target;
				}
			}

			// If no args or invalid args, show selector
			if (!target) {
				fromSelector = true;
			}

			while (true) {
				if (!target && fromSelector) {
					target = await showReviewSelector(ctx);
				}

				if (!target) {
					ctx.ui.notify("Review cancelled", "info");
					return;
				}

				// Determine if we should use fresh session mode
				// Check if this is a new session (no messages yet)
				const entries = ctx.sessionManager.getEntries();
				const messageCount = entries.filter((e) => e.type === "message").length;

				// In an empty session, default to fresh review mode so /end-review works consistently.
				let useFreshSession = messageCount === 0;

				if (messageCount > 0) {
					// Existing session - ask user which mode they want
					const choice = await ctx.ui.select("Start review in:", ["Empty branch", "Current session"]);

					if (choice === undefined) {
						if (fromSelector) {
							target = null;
							continue;
						}
						ctx.ui.notify("Review cancelled", "info");
						return;
					}

					useFreshSession = choice === "Empty branch";
				}

				await executeReview(ctx, target, useFreshSession, { extraInstruction });
				return;
			}
		},
	});

	// Custom prompt for review summaries - focuses on preserving actionable findings
	const ReviewSummaryPrompt = `We are leaving a code-review branch and returning to the main coding branch.
Create a structured handoff that can be used immediately to implement fixes.

You MUST summarize the review that happened in this branch so findings can be acted on.
Do not omit findings: include every actionable issue that was identified.

Required sections (in order):

## Review Scope
- What was reviewed (files/paths, changes, and scope)

## Verdict
- "correct" or "needs attention"

## Findings
For EACH finding, include:
- Priority tag ([P0]..[P3]) and short title
- File location (\`path/to/file.ext:line\`)
- Why it matters (brief)
- What should change (brief, actionable)

## Fix Queue
1. Ordered implementation checklist (highest priority first)

## Constraints & Preferences
- Any constraints or preferences mentioned during review
- Or "(none)"

## Human Reviewer Callouts (Non-Blocking)
Include only applicable callouts (no yes/no lines):
- **This change adds a database migration:** <files/details>
- **This change introduces a new dependency:** <package(s)/details>
- **This change changes a dependency (or the lockfile):** <files/package(s)/details>
- **This change modifies auth/permission behavior:** <what changed and where>
- **This change introduces backwards-incompatible public schema/API/contract changes:** <what changed and where>
- **This change includes irreversible or destructive operations:** <operation and scope>
- **This change adds or removes feature flags:** <feature flags changed>
- **This change changes configuration defaults:** <config var changed>
- **This change changes observability behavior:** <logging, metrics, or tracing details>
- **This change creates rollout or rollback concerns:** <operational concern>

If none apply, write "- (none)".

These are informational callouts for humans and are not fix items by themselves.

Preserve exact file paths, function names, and error messages where available.`;

	const ReviewFixFindingsPrompt = `Use the latest review summary in this session and implement the review findings now.

Instructions:
1. Treat the summary's Findings/Fix Queue as a checklist.
2. Fix in priority order: P0, P1, then P2 (include P3 if quick and safe).
3. If a finding is invalid/already fixed/not possible right now, briefly explain why and continue.
4. Treat "Human Reviewer Callouts (Non-Blocking)" as informational only; do not convert them into fix tasks unless there is a separate explicit finding.
5. Follow fail-fast error handling: do not add local catch/fallback recovery unless this scope is an explicit boundary that can safely translate the failure.
6. If you add or keep a \`try/catch\`, explain the expected failure mode and either rethrow with context or return a boundary-safe error response.
7. JSON parsing/decoding should fail loudly by default; avoid silent fallback parsing.
8. Run relevant tests/checks for touched code where practical.
9. End with: fixed items, deferred/skipped items (with reasons), and verification results.`;

	type EndReviewAction = "returnOnly" | "returnAndFix" | "returnAndSummarize";
	type EndReviewActionResult = "ok" | "cancelled" | "error";
	interface EndReviewActionOptions {
		showSummaryLoader?: boolean;
		notifySuccess?: boolean;
	}

	function getActiveReviewOrigin(ctx: ExtensionContext): string | undefined {
		if (reviewOriginId) {
			return reviewOriginId;
		}

		const state = getReviewState(ctx);
		if (state?.active && state.originId) {
			reviewOriginId = state.originId;
			reviewCheckoutState = state.checkout;
			return reviewOriginId;
		}

		if (state?.active) {
			setReviewWidget(ctx, false);
			reviewCheckoutState = undefined;
			pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
			ctx.ui.notify("Review state was missing origin info; cleared review status.", "warning");
		}
		return undefined;
	}

	function clearReviewState(ctx: ExtensionContext) {
		setReviewWidget(ctx, false);
		reviewOriginId = undefined;
		reviewCheckoutState = undefined;
		pi.appendEntry(REVIEW_STATE_TYPE, { active: false });
	}

	async function navigateWithSummary(
		ctx: ExtensionCommandContext,
		originId: string,
		showLoader: boolean,
	): Promise<{ cancelled: boolean; error?: string } | null> {
		if (showLoader && ctx.hasUI) {
			return ctx.ui.custom<{ cancelled: boolean; error?: string } | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, "Returning and summarizing review branch...");
				loader.onAbort = () => done(null);

				ctx
					.navigateTree(originId, {
						summarize: true,
						customInstructions: ReviewSummaryPrompt,
						replaceInstructions: true,
					})
					.then(done)
					.catch((err) => done({ cancelled: false, error: err instanceof Error ? err.message : String(err) }));

				return loader;
			});
		}

		try {
			return await ctx.navigateTree(originId, {
				summarize: true,
				customInstructions: ReviewSummaryPrompt,
				replaceInstructions: true,
			});
		} catch (error) {
			return { cancelled: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function executeEndReviewAction(
		ctx: ExtensionCommandContext,
		action: EndReviewAction,
		options: EndReviewActionOptions = {},
	): Promise<EndReviewActionResult> {
		const originId = getActiveReviewOrigin(ctx);
		if (!originId) {
			if (!getReviewState(ctx)?.active) {
				ctx.ui.notify(
					"Not in a review branch (use /review first, or review was started in current session mode)",
					"info",
				);
			}
			return "error";
		}

		const notifySuccess = options.notifySuccess ?? true;
		const checkoutState = reviewCheckoutState;

		if (action === "returnOnly") {
			try {
				const result = await ctx.navigateTree(originId, { summarize: false });
				if (result.cancelled) {
					ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
					return "cancelled";
				}
			} catch (error) {
				ctx.ui.notify(`Failed to return: ${error instanceof Error ? error.message : String(error)}`, "error");
				return "error";
			}
			reviewCheckoutState = checkoutState;
			if (!(await restoreReviewCheckout(ctx))) {
				return "error";
			}

			clearReviewState(ctx);
			if (notifySuccess) {
				ctx.ui.notify("Review complete! Returned to original position.", "info");
			}
			return "ok";
		}

		const summaryResult = await navigateWithSummary(ctx, originId, options.showSummaryLoader ?? false);
		if (summaryResult === null) {
			ctx.ui.notify("Summarization cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}

		if (summaryResult.error) {
			ctx.ui.notify(`Summarization failed: ${summaryResult.error}`, "error");
			return "error";
		}

		if (summaryResult.cancelled) {
			ctx.ui.notify("Navigation cancelled. Use /end-review to try again.", "info");
			return "cancelled";
		}
		reviewCheckoutState = checkoutState;
		if (!(await restoreReviewCheckout(ctx))) {
			return "error";
		}

		clearReviewState(ctx);

		if (action === "returnAndSummarize") {
			if (!ctx.ui.getEditorText().trim()) {
				ctx.ui.setEditorText("Act on the review findings");
			}
			if (notifySuccess) {
				ctx.ui.notify("Review complete! Returned and summarized.", "info");
			}
			return "ok";
		}

		pi.sendUserMessage(ReviewFixFindingsPrompt, { deliverAs: "followUp" });
		if (notifySuccess) {
			ctx.ui.notify("Review complete! Returned and queued a follow-up to fix findings.", "info");
		}
		return "ok";
	}

	async function runEndReview(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("End-review requires interactive mode", "error");
			return;
		}

		if (endReviewInProgress) {
			ctx.ui.notify("/end-review is already running", "info");
			return;
		}

		endReviewInProgress = true;
		try {
			const choice = await ctx.ui.select("Finish review:", [
				"Return only",
				"Return and fix findings",
				"Return and summarize",
			]);

			if (choice === undefined) {
				ctx.ui.notify("Cancelled. Use /end-review to try again.", "info");
				return;
			}

			const action: EndReviewAction =
				choice === "Return and fix findings"
					? "returnAndFix"
					: choice === "Return and summarize"
						? "returnAndSummarize"
						: "returnOnly";

			await executeEndReviewAction(ctx, action, {
				showSummaryLoader: true,
				notifySuccess: true,
			});
		} finally {
			endReviewInProgress = false;
		}
	}

	// Register the /end-review command
	pi.registerCommand("end-review", {
		description: "Complete review and return to original position",
		handler: async (_args, ctx) => {
			await runEndReview(ctx);
		},
	});
}

export {
	createBranchSelectorItems,
	createCommitSelectorItems,
	filterReviewSelectorItems,
	repositoryFromPrReference,
	resolveReviewTarget,
	sortReviewBranches,
};
