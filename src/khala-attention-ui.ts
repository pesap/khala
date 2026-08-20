// The interactive /khala surface renders the Archive-backed attention
// projection with Pi's built-in selector and notifications. It never exposes a
// writable Conclave session path or raw Executor rows. Observer pane inspection
// stays a clearly secondary read-only selection and reads the Archive itself.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createArchiveSnapshot } from "./khala-archive-projections.js";
import {
	buildKhalaAttention,
	type KhalaAttentionItem,
	type KhalaAttentionSummary,
	type KhalaRecoveryAttention,
} from "./khala-attention.js";
import { LauncherName, type LauncherNameValue } from "./khala-config.js";
import { type ExecutorRecord, ExecutorStatus } from "./khala-model.js";
import {
	listAvailableExecutorModelIds,
	listPendingExecutorModelRecoveries,
	recordUserExecutorModelRecovery,
} from "./khala-model-recovery.js";

type KhalaObserverInspection = Readonly<{
	executorName: string;
	launcher: LauncherNameValue;
	target: string;
}>;

type KhalaAttentionOption = Readonly<{
	label: string;
	detail?: string;
	level?: "info" | "warning";
	observer?: KhalaObserverInspection;
	modelRecovery?: Readonly<{ workId: string; missionId: string; executionId: string }>;
}>;

type ObserverViewer = (launcher: LauncherNameValue, target: string) => Promise<void>;

async function showKhalaAttention(context: ExtensionContext, viewObserver: ObserverViewer | undefined): Promise<void> {
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const summary = buildKhalaAttention(context.cwd, projectTrusted);
	const observers = listObservers(context.cwd, projectTrusted);
	if (context.mode !== "tui") {
		context.ui.notify(renderKhalaAttentionSummary(summary), attentionNotifyLevel(summary));
		return;
	}
	if (summary.condition === "working" && observers.length === 0) {
		context.ui.notify(renderKhalaAttentionSummary(summary), "info");
		return;
	}
	const options = buildAttentionOptions(summary, observers);
	const labels = options.map((candidate) => candidate.label);
	const choice = await context.ui.select(attentionTitle(summary), labels);
	if (choice === undefined) {
		return;
	}
	const option = options[labels.indexOf(choice)];
	if (option === undefined) {
		return;
	}
	if (option.observer !== undefined) {
		await viewObserverPane(option.observer, viewObserver, context);
		return;
	}
	if (option.modelRecovery !== undefined) {
		await selectExecutorRecoveryModel(option.modelRecovery, context);
		return;
	}
	context.ui.notify(option.detail ?? option.label, option.level ?? "info");
}

async function viewObserverPane(
	observer: KhalaObserverInspection,
	viewObserver: ObserverViewer | undefined,
	context: ExtensionContext,
): Promise<void> {
	if (viewObserver === undefined) {
		context.ui.notify("Observer pane inspection is only available in Pi's interactive mode.", "warning");
		return;
	}
	try {
		await viewObserver(observer.launcher, observer.target);
	} catch {
		// Focusing a pane is a UI operation; a failed focus must not surface runtime state.
		context.ui.notify("The Observer pane could not be focused.", "warning");
	}
}

function listObservers(projectPath: string, projectTrusted: boolean): KhalaObserverInspection[] {
	const archive = createArchiveSnapshot(projectPath, projectTrusted);
	// Collapse append-ordered execution history by executionId so a stale
	// running record followed by a failed or finished record offers no
	// inspection option.
	const latestByExecution = new Map<string, ExecutorRecord>();
	for (const execution of archive.listExecutions()) {
		latestByExecution.set(execution.executionId, execution);
	}
	const observers: KhalaObserverInspection[] = [];
	for (const execution of latestByExecution.values()) {
		const view = observerView(execution);
		if (view !== undefined) {
			observers.push(view);
		}
	}
	return observers;
}

function observerView(execution: ExecutorRecord): KhalaObserverInspection | undefined {
	if (execution.kind !== "observer") {
		return;
	}
	if (execution.status !== ExecutorStatus.starting && execution.status !== ExecutorStatus.running) {
		return;
	}
	if (execution.target === undefined || execution.target.length === 0) {
		return;
	}
	if (
		execution.launcher !== LauncherName.zellij &&
		execution.launcher !== LauncherName.tmux &&
		execution.launcher !== LauncherName.herdr
	) {
		return;
	}
	return { executorName: execution.executorName, launcher: execution.launcher, target: execution.target };
}

function renderKhalaAttentionSummary(summary: KhalaAttentionSummary): string {
	if (summary.condition === "working") {
		return activeWorkText(summary);
	}
	const lines = ["Khala — action required"];
	for (const item of summary.reviewRequested) {
		lines.push(`Review requested [${item.workId}]: ${item.title} — ${item.detail}`);
	}
	for (const item of summary.stoppedWork) {
		lines.push(`Stopped Work [${item.workId}]: ${item.title} — ${item.detail}`);
	}
	if (summary.recovery !== undefined) {
		lines.push(renderRecovery(summary.recovery));
	}
	return lines.join("\n");
}

function activeWorkText(summary: KhalaAttentionSummary): string {
	const count = summary.activeWorkCount;
	if (count === 0) {
		return "Khala: no active Work. No user action required.";
	}
	return `Khala: ${count} active Work submission${pluralSuffix(count)}. No user action required.`;
}

function pluralSuffix(count: number): string {
	if (count === 1) {
		return "";
	}
	return "s";
}

function renderRecovery(recovery: KhalaRecoveryAttention): string {
	if (recovery.kind === "executor-model") {
		return `Khala recovery needed: select a different Executor model. ${recovery.message}`;
	}
	if (recovery.kind === "setup") {
		return `Khala recovery needed: run npx --yes --silent github:pesap/khala setup. ${recovery.message}`;
	}
	return `Khala recovery needed: run /khala-recreate. ${recovery.message}`;
}

function attentionTitle(summary: KhalaAttentionSummary): string {
	if (summary.condition === "action-required") {
		return "Khala — action required";
	}
	return "Khala — no user action required";
}

function attentionNotifyLevel(summary: KhalaAttentionSummary): "info" | "warning" {
	if (summary.condition === "action-required") {
		return "warning";
	}
	return "info";
}

function buildAttentionOptions(
	summary: KhalaAttentionSummary,
	observers: readonly KhalaObserverInspection[],
): KhalaAttentionOption[] {
	const options: KhalaAttentionOption[] = [];
	for (const item of summary.reviewRequested) {
		options.push(reviewOption(item));
	}
	for (const item of summary.stoppedWork) {
		options.push(stoppedOption(item));
	}
	if (summary.recovery !== undefined) {
		options.push(recoveryOption(summary.recovery));
	}
	for (const observer of observers) {
		options.push(observerOption(observer));
	}
	return options;
}

function reviewOption(item: KhalaAttentionItem): KhalaAttentionOption {
	return {
		label: `Review requested: ${item.title}`,
		detail: `Work ${item.workId} is ready for review: ${item.detail}`,
		level: "info",
	};
}

function stoppedOption(item: KhalaAttentionItem): KhalaAttentionOption {
	return {
		label: `Stopped Work: ${item.title}`,
		detail: `Work ${item.workId}: ${item.detail}`,
		level: "warning",
	};
}

function recoveryOption(recovery: KhalaRecoveryAttention): KhalaAttentionOption {
	const option: KhalaAttentionOption = {
		label: `Khala recovery needed: ${recoveryShortInstruction(recovery.kind)}`,
		detail: renderRecovery(recovery),
		level: "warning",
	};
	if (
		recovery.kind === "executor-model" &&
		recovery.workId !== undefined &&
		recovery.missionId !== undefined &&
		recovery.executionId !== undefined
	) {
		return {
			...option,
			modelRecovery: {
				workId: recovery.workId,
				missionId: recovery.missionId,
				executionId: recovery.executionId,
			},
		};
	}
	return option;
}

function recoveryShortInstruction(kind: "setup" | "recreate" | "executor-model"): string {
	if (kind === "executor-model") {
		return "select a different Executor model";
	}
	if (kind === "setup") {
		return "run setup";
	}
	return "run /khala-recreate";
}

async function selectExecutorRecoveryModel(
	recovery: Readonly<{ workId: string; missionId: string; executionId: string }>,
	context: ExtensionContext,
): Promise<boolean> {
	try {
		const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
		const pending = listPendingExecutorModelRecoveries(context.cwd, projectTrusted).find(
			(candidate) =>
				candidate.execution.executionId === recovery.executionId && candidate.mission.missionId === recovery.missionId,
		);
		if (pending === undefined) {
			throw new Error("The failed Executor recovery is no longer current.");
		}
		const models = (await listAvailableExecutorModelIds()).filter((model) => model !== pending.execution.model);
		if (models.length === 0) {
			throw new Error("No alternate authenticated Executor model is available.");
		}
		const selected = await context.ui.select("Select an Executor model for this recovery", [...models]);
		if (selected === undefined) {
			return false;
		}
		await recordUserExecutorModelRecovery({
			projectPath: context.cwd,
			projectTrusted,
			pending,
			model: selected,
		});
		context.ui.notify(`Selected Executor model ${selected}. Run /khala-recreate to resume this Work.`, "info");
		return true;
	} catch (error) {
		let message = String(error);
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			message = errorMessage;
		}
		context.ui.notify(message, "error");
		return false;
	}
}

function observerOption(observer: KhalaObserverInspection): KhalaAttentionOption {
	return {
		label: `Inspect Observer pane (read-only): ${observer.executorName}`,
		observer,
	};
}

export type { KhalaAttentionOption };
export { renderKhalaAttentionSummary, selectExecutorRecoveryModel, showKhalaAttention };
