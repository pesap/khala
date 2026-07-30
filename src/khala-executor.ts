import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExecutorStarter, type ExecutorStarter, type PiCommand } from "./executor.js";
import { LauncherName, type LauncherNameValue, loadKhalaConfig } from "./khala-config.js";
import type { ExecutorRecord } from "./khala-model.js";
import { resolvePackageRoot } from "./khala-package.js";
import { latestPullRequest, recordReviewFinalization } from "./khala-review.js";
import { createHerdrLauncher } from "./launch-herdr.js";
import { createTmuxLauncher } from "./launch-tmux.js";
import { createZellijLauncher } from "./launch-zellij.js";
import type { Launcher } from "./launcher.js";
import { createGitWorktreeProvider } from "./vcs-git-worktree.js";

type ExecutorStarterFactory = (context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">) => ExecutorStarter;
type ExecutorViewer = (launcherName: LauncherNameValue, target: string) => Promise<void>;
type ExecutorCloser = (launcherName: LauncherNameValue, target: string) => Promise<void>;
type LauncherFactory = () => Launcher;

const LAUNCHER_FACTORIES: Record<LauncherNameValue, LauncherFactory> = {
	[LauncherName.tmux]: createTmuxLauncher,
	[LauncherName.zellij]: createZellijLauncher,
	[LauncherName.herdr]: createHerdrLauncher,
};

// Concrete providers are composed here once; Work and UI flows depend only on ExecutorStarterFactory.
function createConfiguredExecutorStarter(context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExecutorStarter {
	return createConfiguredStarter(context, false);
}

function createConfiguredObserverStarter(context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExecutorStarter {
	return createConfiguredStarter(context, true);
}

function createConfiguredStarter(
	context: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	observer: boolean,
): ExecutorStarter {
	const config = loadKhalaConfig(context.cwd, context.isProjectTrusted());
	const {
		launcher: launcherName,
		piCommand: executorPiCommand,
		observerPiCommand,
		observerModel,
		executorThinking,
		observerThinking,
	} = config;
	const launcher = LAUNCHER_FACTORIES[launcherName]();
	let piCommand = executorPiCommand;
	let model: string | undefined;
	let thinkingLevel: string | undefined = executorThinking || undefined;
	if (observer) {
		model = observerModel || undefined;
		thinkingLevel = observerThinking || undefined;
		if (model === undefined) {
			piCommand = observerPiCommand;
		} else {
			piCommand = removeModelSelection(observerPiCommand);
		}
	}
	if (thinkingLevel !== undefined) {
		piCommand = removeThinkingSelection(piCommand);
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

// The explicit observerModel field supersedes the older inline --model command argument.
function removeModelSelection(command: PiCommand): PiCommand {
	return removeOptionSelection(command, "--model");
}

function removeThinkingSelection(command: PiCommand): PiCommand {
	return removeOptionSelection(command, "--thinking");
}

function removeOptionSelection(command: PiCommand, option: string): PiCommand {
	const [program, ...arguments_] = command;
	const filteredArguments: string[] = [];
	let skipNext = false;
	for (const argument of arguments_) {
		if (skipNext) {
			skipNext = false;
		} else if (argument === option) {
			skipNext = true;
		} else if (!argument.startsWith(`${option}=`)) {
			filteredArguments.push(argument);
		}
	}
	return [program, ...filteredArguments];
}

function createExecutorViewer(): ExecutorViewer {
	return (launcherName, target) => LAUNCHER_FACTORIES[launcherName]().focus(target);
}

function createExecutorCloser(): ExecutorCloser {
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
	const config = loadKhalaConfig(execution.projectPath, projectTrusted);
	const provider = createGitWorktreeProvider(config.worktreeRoot, config.worktreeBranchPrefix);
	const existingReview = latestPullRequest(execution.projectPath, execution.executionId, projectTrusted);
	const reviewBody = [`Work: ${workId}`, `Execution: ${execution.executionId}`];
	if (existingReview !== undefined) {
		reviewBody.push(`Mission: ${existingReview.missionId}`);
	}
	if (existingReview?.relatedPullRequestUrl !== undefined) {
		reviewBody.push(`Related Pull Request: ${existingReview.relatedPullRequestUrl}`);
	}
	reviewBody.push("", summary, ...evidence);
	const preparation = await provider.finalizeReview(
		{
			sandbox: { path: execution.sandboxPath, name: execution.executorName, projectPath: execution.projectPath },
			name: execution.executorName,
			workId,
			executionId: execution.executionId,
			mission: "",
			publish: config.publishExecutorBranches,
			targetBranch: config.pullRequestTargetBranch,
		},
		existingReview?.url,
		reviewBody.join("\n"),
	);
	if (preparation !== undefined) {
		recordReviewFinalization({
			projectPath: execution.projectPath,
			projectTrusted,
			executionId: execution.executionId,
			headCommit: preparation.headCommit,
			summary,
			evidence,
		});
	}
}

async function sendConfiguredExecutorMessage(execution: ExecutorRecord, message: string): Promise<void> {
	const launcher = LAUNCHER_FACTORIES[execution.launcher as LauncherNameValue];
	if (launcher === undefined) {
		throw new Error(`Unsupported Executor launcher: ${execution.launcher}`);
	}
	if (execution.target === undefined || execution.target.length === 0) {
		throw new Error("The Executor has no active launcher target.");
	}
	await launcher().send(execution.target, message);
}

export type { ExecutorCloser, ExecutorReviewFinalization, ExecutorStarterFactory, ExecutorViewer };
export {
	createConfiguredExecutorStarter,
	createConfiguredObserverStarter,
	createExecutorCloser,
	createExecutorViewer,
	finalizeConfiguredExecutorReview,
	sendConfiguredExecutorMessage,
};
