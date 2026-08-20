import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createExecutorStarter,
	type ExecutorStarter,
	KHALA_HEADLESS_LAUNCHER,
	sendHeadlessExecutorMessage,
} from "./executor.js";
import { LauncherName, type LauncherNameValue, loadKhalaConfig } from "./khala-config.js";
import type { ExecutorRecord } from "./khala-model.js";
import { resolvePackageRoot } from "./khala-package.js";
import { removePiOptionSelection } from "./khala-pi-command.js";
import type { ReviewFinalizationInput } from "./khala-review.js";
import { latestPullRequest, recordReviewFinalization } from "./khala-review.js";
import { createHerdrLauncher } from "./launch-herdr.js";
import { createTmuxLauncher } from "./launch-tmux.js";
import { createZellijLauncher } from "./launch-zellij.js";
import type { Launcher } from "./launcher.js";
import { createGitWorktreeProvider } from "./vcs-git-worktree.js";

type ExecutorStarterFactory = (
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	modelOverride?: string,
) => ExecutorStarter;
type ObserverViewer = (launcherName: LauncherNameValue, target: string) => Promise<void>;
type ObserverCloser = (launcherName: LauncherNameValue, target: string) => Promise<void>;
type LauncherFactory = () => Launcher;

const LAUNCHER_FACTORIES: Record<LauncherNameValue, LauncherFactory> = {
	[LauncherName.tmux]: createTmuxLauncher,
	[LauncherName.zellij]: createZellijLauncher,
	[LauncherName.herdr]: createHerdrLauncher,
};

// Concrete providers are composed here once; Work and UI flows depend only on ExecutorStarterFactory.
function createConfiguredExecutorStarter(
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	modelOverride?: string,
): ExecutorStarter {
	return createConfiguredStarter(context, false, modelOverride);
}

function createConfiguredObserverStarter(context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExecutorStarter {
	return createConfiguredStarter(context, true);
}

function createConfiguredStarter(
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	observer: boolean,
	modelOverride?: string,
): ExecutorStarter {
	const config = loadKhalaConfig(context.cwd, context.isProjectTrusted(), !observer);
	const {
		launcher: launcherName,
		piCommand: configuredPiCommand,
		observerModel,
		executorModel,
		executorThinking,
		observerThinking,
	} = config;
	let launcher: Launcher | undefined;
	if (observer) {
		launcher = LAUNCHER_FACTORIES[launcherName]();
	}
	let piCommand = configuredPiCommand;
	let model: string | undefined = modelOverride ?? executorModel;
	let thinkingLevel: string | undefined = executorThinking || undefined;
	if (observer) {
		model = observerModel || undefined;
		thinkingLevel = observerThinking || undefined;
	}
	if (model !== undefined) {
		piCommand = removePiOptionSelection(piCommand, "--model");
	}
	if (thinkingLevel !== undefined) {
		piCommand = removePiOptionSelection(piCommand, "--thinking");
	}
	const packageRoot = resolvePackageRoot(dirname(fileURLToPath(import.meta.url)));
	const khalaSkillPath = join(packageRoot, "skills", "khala");
	const skillPaths: string[] = [khalaSkillPath];
	if (!observer) {
		skillPaths.push(join(packageRoot, "skills", "khala-executor"));
	}
	return createExecutorStarter(
		createGitWorktreeProvider(config.worktreeRoot, config.worktreeBranchPrefix),
		launcher,
		piCommand,
		launcherName,
		model,
		skillPaths,
		thinkingLevel,
	);
}

function createObserverViewer(): ObserverViewer {
	return (launcherName, target) => LAUNCHER_FACTORIES[launcherName]().focus(target);
}

function createObserverCloser(): ObserverCloser {
	return (launcherName, target) => LAUNCHER_FACTORIES[launcherName]().close(target);
}

type ExecutorReviewFinalization = Readonly<{
	execution: ExecutorRecord;
	workId: string;
	projectTrusted: boolean;
	summary: string;
	evidence: readonly string[];
}>;

async function finalizeConfiguredExecutorReview(input: ExecutorReviewFinalization): Promise<void> {
	const { execution, workId, projectTrusted, summary, evidence } = input;
	const config = loadKhalaConfig(execution.projectPath, projectTrusted, true);
	const provider = createGitWorktreeProvider(config.worktreeRoot, config.worktreeBranchPrefix);
	const existingReview = latestPullRequest(execution.projectPath, execution.executionId, projectTrusted);
	let reviewRequest: {
		sandbox: { path: string; name: string; projectPath: string };
		name: string;
		workId: string;
		executionId: string;
		mission: string;
		publish: boolean;
		targetBranch: string;
		supersedesPullRequestUrl?: string;
	} = {
		sandbox: { path: execution.sandboxPath, name: execution.executorName, projectPath: execution.projectPath },
		name: execution.executorName,
		workId,
		executionId: execution.executionId,
		mission: "",
		publish: true,
		targetBranch: config.pullRequestTargetBranch,
	};
	if (existingReview?.relatedPullRequestUrl !== undefined) {
		reviewRequest = {
			...reviewRequest,
			supersedesPullRequestUrl: existingReview.relatedPullRequestUrl,
		};
	}
	let confirmedReviewUrl: string | undefined;
	if (existingReview?.remoteConfirmedAt !== undefined) {
		confirmedReviewUrl = existingReview.url;
	}
	const preparation = await provider.finalizeReview(reviewRequest, confirmedReviewUrl);
	if (preparation === undefined || preparation.url === undefined || preparation.url.trim().length === 0) {
		throw new Error("Executor Pull Request finalization did not produce a published Pull Request URL.");
	}
	let finalization: ReviewFinalizationInput = {
		projectPath: execution.projectPath,
		projectTrusted,
		executionId: execution.executionId,
		headCommit: preparation.headCommit,
		summary,
		evidence,
		url: preparation.url,
	};
	if (preparation.number !== undefined) {
		finalization = { ...finalization, number: preparation.number };
	}
	recordReviewFinalization(finalization);
	if (existingReview?.relatedPullRequestUrl !== undefined) {
		await provider.supersedePullRequest(existingReview.relatedPullRequestUrl, preparation.url);
	}
}

async function sendConfiguredExecutorMessage(execution: ExecutorRecord, message: string): Promise<void> {
	if (execution.kind !== "executor" || execution.launcher !== KHALA_HEADLESS_LAUNCHER) {
		throw new Error("Verdict delivery requires a headless Executor runtime.");
	}
	await sendHeadlessExecutorMessage(execution.executionId, message);
}

export type { ExecutorReviewFinalization, ExecutorStarterFactory, ObserverCloser, ObserverViewer };
export {
	createConfiguredExecutorStarter,
	createConfiguredObserverStarter,
	createObserverCloser,
	createObserverViewer,
	finalizeConfiguredExecutorReview,
	sendConfiguredExecutorMessage,
};
