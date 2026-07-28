import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExecutorStarter, type ExecutorStarter, type PiCommand } from "./executor.js";
import { LauncherName, type LauncherNameValue, loadKhalaConfig } from "./khala-config.js";
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
	const { launcher: launcherName, piCommand: executorPiCommand, observerPiCommand, observerModel } = config;
	const launcher = LAUNCHER_FACTORIES[launcherName]();
	let piCommand = executorPiCommand;
	let model: string | undefined;
	if (observer) {
		model = observerModel || undefined;
		if (model === undefined) {
			piCommand = observerPiCommand;
		} else {
			piCommand = removeModelSelection(observerPiCommand);
		}
	}
	return createExecutorStarter(
		createGitWorktreeProvider(config.worktreeRoot, config.worktreeBranchPrefix),
		launcher,
		piCommand,
		launcherName,
		model,
	);
}

// The explicit observerModel field supersedes the older inline --model command argument.
function removeModelSelection(command: PiCommand): PiCommand {
	const [program, ...arguments_] = command;
	const filteredArguments: string[] = [];
	let skipNext = false;
	for (const argument of arguments_) {
		if (skipNext) {
			skipNext = false;
		} else if (argument === "--model") {
			skipNext = true;
		} else if (!argument.startsWith("--model=")) {
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

export type { ExecutorCloser, ExecutorStarterFactory, ExecutorViewer };
export { createConfiguredExecutorStarter, createConfiguredObserverStarter, createExecutorCloser, createExecutorViewer };
