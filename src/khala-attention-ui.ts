// The interactive /khala surface renders the Archive-backed attention
// projection with selector components and notifications. It never exposes a
// writable Conclave session path or raw Executor rows. Observer pane inspection
// stays a clearly secondary read-only selection and reads the Archive itself.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: Work and project selectors keep their user-facing behavior together.
// biome-ignore-all lint/style/noTernary: Optional UI fields remain explicit at the interaction boundary.
// biome-ignore-all lint/style/useBlockStatements: Short label mappings remain readable as guarded returns.
// biome-ignore-all lint/style/noContinue: Returning from nested selectors re-enters the parent menu explicitly.
// biome-ignore-all lint/performance/noAwaitInLoops: The bounded selector loop must await each nested menu before redrawing.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: The attention selector keeps menu transitions and action dispatch together.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: The custom selector component keeps its render and input state together.
// biome-ignore-all lint/complexity/useMaxParams: UI handlers preserve explicit Work and controller identity.
import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionContext,
	type ModelRuntime,
	ModelSelectorComponent,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { createArchiveSnapshot } from "./khala-archive-projections.js";
import {
	type KhalaAttentionSummary,
	type KhalaAttentionView,
	type ProjectAttention,
	resolveKhalaAttention,
	type WorkAttention,
	type WorkAttentionAction,
} from "./khala-attention.js";
import type { ConclaveCoordinator } from "./khala-conclave.js";
import { LauncherName, type LauncherNameValue } from "./khala-config.js";
import { type ExecutorRecord, ExecutorStatus, isMissionExecutorRecord } from "./khala-model.js";
import { listPendingExecutorModelRecoveries, recordUserExecutorModelRecovery } from "./khala-model-recovery.js";
import { appendAttentionDismissal, userWorkerActionId } from "./khala-user-worker-action.js";

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
	work?: WorkAttention;
	project?: ProjectAttention;
}>;

type ObserverViewer = (launcher: LauncherNameValue, target: string) => Promise<void>;
type WorkerActionKind = Extract<
	WorkAttentionAction,
	"try-current-execution" | "continue-current-mission" | "stop-current-execution"
>;
type KhalaAttentionController = Pick<
	ConclaveCoordinator,
	"executeWorkerAction" | "hasLiveExecutionRuntime" | "probeExecutionRuntime"
>;
type ConclaveRecoveryTrigger = (context: ExtensionContext) => void | Promise<void>;

async function showKhalaAttention(
	context: ExtensionContext,
	viewObserver: ObserverViewer | undefined,
	controller?: KhalaAttentionController,
	recoverConclave?: ConclaveRecoveryTrigger,
): Promise<void> {
	for (;;) {
		const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
		const view = await resolveKhalaAttention(
			context.cwd,
			projectTrusted,
			controller?.probeExecutionRuntime === undefined
				? undefined
				: (executionId) => controller.probeExecutionRuntime(context.cwd, executionId, projectTrusted),
		);
		const observers = listObservers(context.cwd, projectTrusted);
		if (context.mode !== "tui") {
			context.ui.notify(renderKhalaAttentionView(view), viewRequiresAction(view) ? "warning" : "info");
			return;
		}
		if (!viewRequiresAction(view) && observers.length === 0) {
			context.ui.notify(renderKhalaAttentionView(view), "info");
			return;
		}
		const options = buildAttentionOptions(view, observers);
		const option = await selectAttentionOption(context, view, options);
		if (option === undefined) {
			return;
		}
		if (option.observer !== undefined) {
			await viewObserverPane(option.observer, viewObserver, context);
			return;
		}
		if (option.work !== undefined) {
			const returnToMenu = await openWorkAttention(option.work, context, controller, recoverConclave);
			if (returnToMenu) {
				continue;
			}
			return;
		}
		if (option.project !== undefined) {
			const returnToMenu = await openProjectAttention(option.project, context);
			if (returnToMenu) {
				continue;
			}
			return;
		}
		context.ui.notify(option.detail ?? option.label, option.level ?? "info");
		return;
	}
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

function hasLiveMissionExecutor(
	item: WorkAttention,
	context: ExtensionContext,
	controller: KhalaAttentionController | undefined,
): boolean {
	if (item.missionId === undefined || controller === undefined) {
		return false;
	}
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const liveRuntime = (executionId: string): boolean => {
		try {
			return controller.hasLiveExecutionRuntime(context.cwd, executionId, projectTrusted);
		} catch {
			return false;
		}
	};
	const latestByExecution = new Map<string, ExecutorRecord>();
	for (const execution of createArchiveSnapshot(context.cwd, projectTrusted).listExecutions()) {
		latestByExecution.set(execution.executionId, execution);
	}
	return [...latestByExecution.values()].some(
		(execution) =>
			execution.status === ExecutorStatus.running &&
			isMissionExecutorRecord(execution) &&
			execution.workId === item.workId &&
			(execution.missionId ?? execution.purpose.missionId) === item.missionId &&
			liveRuntime(execution.executionId),
	);
}

function renderKhalaAttentionSummary(summary: KhalaAttentionSummary): string {
	if (summary.condition === "working") {
		return activeWorkText(summary);
	}
	const lines = ["Khala — action required"];
	for (const item of summary.work) {
		lines.push(workAttentionLabel(item), `  ${attentionSummaryDetail(item)}`);
	}
	for (const item of summary.project) {
		lines.push(projectAttentionLabel(item), `  ${projectAttentionDetail(item)}`);
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

function renderKhalaAttentionView(view: KhalaAttentionView): string {
	if (!viewRequiresAction(view)) {
		if (view.activeWorkCount === 0) {
			return "Khala: no active Work. No user action required.";
		}
		return `Khala: ${view.activeWorkCount} active Work submission${pluralSuffix(view.activeWorkCount)}. No user action required.`;
	}
	const lines = ["Khala — action required"];
	for (const item of view.work) {
		lines.push(workAttentionLabel(item), `  ${attentionSummaryDetail(item)}`);
	}
	for (const item of view.project) {
		lines.push(projectAttentionLabel(item), `  ${projectAttentionDetail(item)}`);
	}
	return lines.join("\n");
}

function viewRequiresAction(view: KhalaAttentionView): boolean {
	return view.work.length > 0 || view.project.length > 0;
}

function attentionTitle(view: KhalaAttentionView): string {
	return viewRequiresAction(view) ? "Khala — action required" : "Khala — no user action required";
}

function uniqueOptionLabels(labels: readonly string[]): string[] {
	const counts = new Map<string, number>();
	return labels.map((label) => {
		const count = (counts.get(label) ?? 0) + 1;
		counts.set(label, count);
		if (count === 1) {
			return label;
		}
		return `${label} (${count})`;
	});
}

function buildAttentionOptions(
	view: KhalaAttentionView,
	observers: readonly KhalaObserverInspection[],
): KhalaAttentionOption[] {
	return [
		...view.work.map((item) => ({
			label: workAttentionLabel(item),
			detail: item.summary,
			work: item,
		})),
		...view.project.map((item) => ({
			label: projectAttentionLabel(item),
			detail: item.summary,
			level: "warning" as const,
			project: item,
		})),
		...observers.map((observer) => observerOption(observer)),
	];
}

function attentionOptionLabel(candidate: KhalaAttentionOption): string {
	return candidate.label;
}

function attentionSelectorEntries(
	options: readonly KhalaAttentionOption[],
): KhalaSelectorEntry<KhalaAttentionOption>[] {
	const labels = uniqueOptionLabels(options.map((candidate) => attentionOptionLabel(candidate)));
	return options.map((candidate, index) => {
		const label = attentionOptionLabel(candidate);
		return {
			value: candidate,
			label: labels[index] ?? label,
			searchText: `${label} ${candidate.detail ?? ""}`,
		};
	});
}

function selectAttentionOption(
	context: ExtensionContext,
	view: KhalaAttentionView,
	options: readonly KhalaAttentionOption[],
): Promise<KhalaAttentionOption | undefined> {
	return selectKhalaItem(context, attentionTitle(view), attentionSelectorEntries(options), {
		filter: true,
		filterLabel: "Filter missions",
		noMatchText: "No matching missions",
	});
}

type KhalaSelectorEntry<T> = Readonly<{
	value: T;
	label: string;
	searchText?: string;
	detail?: string;
}>;

type KhalaSelectorOptions<T> = Readonly<{
	filter?: boolean;
	filterLabel?: string;
	noMatchText?: string;
	refresh?: () => readonly KhalaSelectorEntry<T>[];
	refreshIntervalMs?: number;
}>;

type KhalaSelectorKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.confirm"
	| "tui.select.cancel"
	| "tui.editor.deleteCharBackward";

function selectKhalaItem<T>(
	context: ExtensionContext,
	title: string,
	entries: readonly KhalaSelectorEntry<T>[],
	options: KhalaSelectorOptions<T> = {},
): Promise<T | undefined> {
	const filter = options.filter === true;
	return context.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		container.addChild(new Spacer(1));
		const searchInput = filter ? new Input() : undefined;
		if (searchInput !== undefined) {
			container.addChild(new Text(theme.italic(theme.fg("muted", options.filterLabel ?? "Filter")), 1, 0));
			container.addChild(searchInput);
			container.addChild(new Spacer(1));
		}
		const listContainer = new Container();
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		const hint = (keybinding: KhalaSelectorKeybinding, description: string): string =>
			theme.fg("dim", keybindings.getKeys(keybinding).join("/")) + theme.fg("muted", ` ${description}`);
		container.addChild(
			new Text(
				filter
					? `${hint("tui.select.up", "up")} ${hint("tui.select.down", "down")}  ${hint("tui.select.confirm", "select")}  ${hint("tui.editor.deleteCharBackward", "filter/back")}  ${hint("tui.select.cancel", "cancel")}`
					: `${hint("tui.select.up", "up")} ${hint("tui.select.down", "down")}  ${hint("tui.select.confirm", "select")}  ${hint("tui.editor.deleteCharBackward", "back")}  ${hint("tui.select.cancel", "cancel")}`,
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));

		let availableEntries = [...entries];
		let filteredEntries = [...availableEntries];
		let selectedIndex = 0;
		const updateList = (): void => {
			listContainer.clear();
			if (filteredEntries.length === 0) {
				listContainer.addChild(
					new Text(theme.fg("warning", `  ${options.noMatchText ?? "No matching entries"}`), 0, 0),
				);
				return;
			}
			const maxVisible = 10;
			const startIndex = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredEntries.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, filteredEntries.length);
			for (let index = startIndex; index < endIndex; index += 1) {
				const entry = filteredEntries[index];
				if (entry === undefined) {
					continue;
				}
				const selected = index === selectedIndex;
				const prefix = selected ? theme.fg("accent", "→ ") : "  ";
				const label = selected ? theme.bold(theme.fg("accent", entry.label)) : theme.fg("text", entry.label);
				listContainer.addChild(new Text(`${prefix}${label}`, 0, 0));
			}
			if (startIndex > 0 || endIndex < filteredEntries.length) {
				listContainer.addChild(new Text(theme.fg("dim", `  (${selectedIndex + 1}/${filteredEntries.length})`), 0, 0));
			}
			const selected = filteredEntries[selectedIndex];
			if (selected?.detail !== undefined) {
				listContainer.addChild(new Spacer(1));
				listContainer.addChild(new Text(theme.italic(theme.fg("muted", `  ${selected.detail}`)), 0, 0));
			}
		};
		const applyFilter = (preferredValue?: T): void => {
			const query = searchInput?.getValue() ?? "";
			filteredEntries =
				query.length === 0
					? [...availableEntries]
					: fuzzyFilter(
							[...availableEntries],
							query,
							(entry) => entry.searchText ?? `${entry.label} ${entry.detail ?? ""}`,
						);
			const preferredIndex =
				preferredValue === undefined ? -1 : filteredEntries.findIndex((entry) => entry.value === preferredValue);
			if (preferredIndex >= 0) {
				selectedIndex = preferredIndex;
			} else if (query.length > 0) {
				selectedIndex = 0;
			} else {
				selectedIndex = Math.min(selectedIndex, Math.max(0, filteredEntries.length - 1));
			}
			updateList();
		};
		const refreshEntries = (): void => {
			if (options.refresh === undefined) {
				return;
			}
			const selectedValue = filteredEntries[selectedIndex]?.value;
			availableEntries = [...options.refresh()];
			applyFilter(selectedValue);
		};
		applyFilter();
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		const finish = (value: T | undefined): void => {
			if (refreshTimer !== undefined) {
				clearInterval(refreshTimer);
				refreshTimer = undefined;
			}
			done(value);
		};
		if (options.refresh !== undefined) {
			refreshTimer = setInterval(() => {
				try {
					refreshEntries();
					tui.requestRender();
				} catch (error) {
					context.ui.notify(errorMessage(error), "error");
					finish(undefined);
				}
			}, options.refreshIntervalMs ?? DEFAULT_SELECTOR_REFRESH_INTERVAL_MS);
		}
		let focused = false;
		return {
			dispose: () => {
				if (refreshTimer !== undefined) {
					clearInterval(refreshTimer);
					refreshTimer = undefined;
				}
			},
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				if (searchInput !== undefined) {
					searchInput.focused = value;
				}
			},
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.up")) {
					if (filteredEntries.length === 0) return;
					selectedIndex = selectedIndex === 0 ? filteredEntries.length - 1 : selectedIndex - 1;
					updateList();
				} else if (keybindings.matches(data, "tui.select.down")) {
					if (filteredEntries.length === 0) return;
					selectedIndex = selectedIndex === filteredEntries.length - 1 ? 0 : selectedIndex + 1;
					updateList();
				} else if (keybindings.matches(data, "tui.select.confirm")) {
					const selected = filteredEntries[selectedIndex];
					if (selected !== undefined) finish(selected.value);
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					finish(undefined);
				} else if (
					filter &&
					searchInput !== undefined &&
					!(keybindings.matches(data, "tui.editor.deleteCharBackward") && searchInput.getValue().length === 0)
				) {
					searchInput.handleInput(data);
					applyFilter();
				} else if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
					finish(undefined);
				}
				tui.requestRender();
			},
		};
	});
}

const ERROR_PREFIX_PATTERN = /^Error:\s*/u;
const DEFAULT_SELECTOR_REFRESH_INTERVAL_MS = 1000;

async function openProjectAttention(item: ProjectAttention, context: ExtensionContext): Promise<boolean> {
	const entries = item.actions.map((projectAction) => ({
		value: projectAction,
		label: projectActionLabel(projectAction),
	}));
	const selectedAction = await selectKhalaItem(context, projectAttentionTitle(item, context.ui.theme), entries);
	if (selectedAction === undefined) {
		return true;
	}
	if (selectedAction === "dismiss") {
		appendAttentionDismissal(context.cwd, { conditionId: item.conditionId, kind: item.kind });
		context.ui.notify("Dismissed this project recovery condition.", "info");
		return false;
	}
	if (selectedAction === "setup") {
		context.ui.notify("Run npx --yes --silent github:pesap/khala setup to configure Khala.", "info");
		return false;
	}
	context.ui.notify("Run /khala-recover to recover the project Conclave.", "info");
	return false;
}

async function openWorkAttention(
	item: WorkAttention,
	context: ExtensionContext,
	controller: KhalaAttentionController | undefined,
	recoverConclave: ConclaveRecoveryTrigger | undefined,
): Promise<boolean> {
	for (;;) {
		let currentItem: WorkAttention | undefined = item;
		try {
			const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
			const refreshed = await resolveKhalaAttention(
				context.cwd,
				projectTrusted,
				controller?.probeExecutionRuntime === undefined
					? undefined
					: (executionId) => controller.probeExecutionRuntime(context.cwd, executionId, projectTrusted),
			);
			currentItem =
				refreshed.work.find(
					(candidate) => candidate.workId === item.workId && candidate.conditionId === item.conditionId,
				) ?? refreshed.work.find((candidate) => candidate.workId === item.workId);
			if (currentItem === undefined) {
				return true;
			}
		} catch (error) {
			context.ui.notify(errorMessage(error), "error");
			return false;
		}
		let actions: readonly WorkAttentionAction[];
		let liveExecutor = false;
		try {
			liveExecutor = hasLiveMissionExecutor(currentItem, context, controller);
			actions = visibleWorkActions(currentItem, context, liveExecutor);
		} catch (error) {
			context.ui.notify(errorMessage(error), "error");
			return false;
		}
		const entries = actions.map((workAction) => ({ value: workAction, label: workActionLabel(workAction) }));
		const selectedAction = await selectKhalaItem(context, workAttentionTitle(currentItem, context.ui.theme), entries);
		if (selectedAction === undefined) {
			return true;
		}
		if (selectedAction === "review") {
			context.ui.notify(currentItem.pullRequestUrl ?? "The Pull Request URL is not available.", "info");
			return false;
		}
		if (selectedAction === "view-attempts") {
			await showAttempts(currentItem, context);
			continue;
		}
		if (selectedAction === "dismiss") {
			appendAttentionDismissal(context.cwd, {
				conditionId: currentItem.conditionId,
				workId: currentItem.workId,
				kind: "work",
			});
			context.ui.notify("Dismissed this Work attention condition.", "info");
			return false;
		}
		if (selectedAction === "recover-conclave") {
			if (recoverConclave === undefined) {
				context.ui.notify("The Khala Conclave is not available to perform this action.", "warning");
				return false;
			}
			try {
				await withAttentionLoader(context, async () => {
					await recoverConclave(context);
				});
			} catch (error) {
				context.ui.notify(errorMessage(error), "error");
			}
			return false;
		}
		if (selectedAction === "select-model") {
			return !(await selectExecutorRecoveryModel(currentItem, context, controller));
		}
		if (selectedAction === "try-same-model") {
			return !(await trySameModelRecovery(currentItem, context, controller));
		}
		if (
			selectedAction !== "try-current-execution" &&
			selectedAction !== "continue-current-mission" &&
			selectedAction !== "stop-current-execution"
		) {
			return true;
		}
		await executeAttentionWorkerAction(currentItem, selectedAction, context, controller);
		return false;
	}
}

type ExecutorModelChoice = Readonly<{ id: string; label: string }>;

function availableExecutorModels(context: ExtensionContext): readonly ExecutorModelChoice[] {
	const currentModelId = context.model === undefined ? undefined : `${context.model.provider}/${context.model.id}`;
	const scopedModels = context.scopedModels ?? [];
	const models =
		scopedModels.length > 0 ? scopedModels.map((scoped) => scoped.model) : context.modelRegistry.getAvailable();
	return models
		.map((model) => ({
			id: `${model.provider}/${model.id}`,
			label: `${model.id}  [${model.provider}]`,
		}))
		.sort((left, right) => {
			if (left.id === currentModelId) return -1;
			if (right.id === currentModelId) return 1;
			return left.label.localeCompare(right.label);
		});
}

function availableExecutorModelIds(context: ExtensionContext): readonly string[] {
	return availableExecutorModels(context).map((model) => model.id);
}

function nativeModelRuntime(context: ExtensionContext): ModelRuntime {
	const modelSnapshot = () => {
		const scopedModels = context.scopedModels ?? [];
		return scopedModels.length > 0 ? scopedModels.map((scoped) => scoped.model) : context.modelRegistry.getAvailable();
	};
	const refresh = async (options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> => {
		if (options.signal?.aborted === true) {
			return { aborted: true, errors: new Map() };
		}
		try {
			await context.modelRegistry.refresh();
			return { aborted: options.signal?.aborted ?? false, errors: new Map() };
		} catch (error) {
			return {
				aborted: options.signal?.aborted ?? false,
				errors: new Map([["model registry", error instanceof Error ? error : new Error(String(error))]]),
			};
		}
	};
	// Pi keeps the live ModelRuntime private to the interactive session. The
	// exported native selector only needs this bounded runtime surface, so adapt
	// the public registry without changing the User's active model.
	return {
		getAvailableSnapshot: modelSnapshot,
		getModel: (providerId: string, modelId: string) => context.modelRegistry.find(providerId, modelId),
		getError: () => context.modelRegistry.getError(),
		refresh,
	} as unknown as ModelRuntime;
}

function selectNativeExecutorModel(
	context: ExtensionContext,
	excludedModelId: string | undefined,
): Promise<string | undefined> {
	return context.ui.custom<string | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			context.model,
			SettingsManager.inMemory(),
			nativeModelRuntime(context),
			context.scopedModels ?? [],
			(model) => {
				const modelId = `${model.provider}/${model.id}`;
				if (modelId === excludedModelId) {
					context.ui.notify("Select a model other than the unavailable Executor model.", "warning");
					return;
				}
				done(modelId);
			},
			() => done(undefined),
		);
		return selector;
	});
}

function visibleWorkActions(
	item: WorkAttention,
	context: ExtensionContext,
	liveExecutor: boolean,
): readonly WorkAttentionAction[] {
	const withoutStaleRecovery = item.actions.filter((action) => action !== "recover-conclave" || !liveExecutor);
	if (!(item.actions.includes("select-model") || item.actions.includes("try-same-model"))) {
		return withoutStaleRecovery;
	}
	const baseActions = withoutStaleRecovery.filter((action) => action !== "try-same-model");
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const pending = listPendingExecutorModelRecoveries(context.cwd, projectTrusted).find(
		(candidate) =>
			candidate.execution.executionId === item.executionId && candidate.mission.missionId === item.missionId,
	);
	if (pending?.execution.model === undefined) {
		return baseActions.filter((action) => action !== "select-model");
	}
	const available = availableExecutorModelIds(context);
	const hasAlternateModel = available.some((model) => model !== pending.execution.model);
	const actions = baseActions.filter((action) => action !== "select-model" || hasAlternateModel);
	if (!available.includes(pending.execution.model)) {
		return actions;
	}
	const attemptsIndex = actions.indexOf("view-attempts");
	if (attemptsIndex < 0) {
		return [...actions, "try-same-model"];
	}
	return [...actions.slice(0, attemptsIndex), "try-same-model", ...actions.slice(attemptsIndex)];
}

async function executeAttentionWorkerAction(
	item: WorkAttention,
	action: WorkerActionKind,
	context: ExtensionContext,
	controller: KhalaAttentionController | undefined,
	model?: string,
): Promise<void> {
	if (controller === undefined || item.missionId === undefined) {
		context.ui.notify("The Khala Conclave is not available to perform this action.", "warning");
		return;
	}
	const kind: WorkerActionKind = action;
	const request = {
		actionId: userWorkerActionId(item.conditionId, kind, model),
		kind,
		conditionId: item.conditionId,
		workId: item.workId,
		expectedMissionId: item.missionId,
		...(item.executionId === undefined ? {} : { expectedExecutionId: item.executionId }),
		...(model === undefined ? {} : { model }),
	};
	try {
		const result = await withAttentionLoader(context, () =>
			controller.executeWorkerAction(
				context.cwd,
				request,
				typeof context.isProjectTrusted === "function" && context.isProjectTrusted(),
			),
		);
		context.ui.notify(renderWorkerActionResult(result.status), workerActionLevel(result.status));
	} catch (error) {
		context.ui.notify(renderAttentionError(error), "error");
	}
}

async function selectExecutorRecoveryModel(
	recovery: WorkAttention | Readonly<{ workId: string; missionId: string; executionId: string }>,
	context: ExtensionContext,
	controller?: KhalaAttentionController,
): Promise<boolean> {
	try {
		if (controller === undefined) {
			throw new Error("The Khala Conclave is not available to perform this action.");
		}
		const attention: WorkAttention =
			"conditionId" in recovery
				? recovery
				: {
						conditionId: `model-recovery:${recovery.workId}:${recovery.missionId}:${recovery.executionId}`,
						workId: recovery.workId,
						title: `Work ${recovery.workId}`,
						summary: "The current worker model is unavailable; select another model",
						actions: ["select-model"],
						missionId: recovery.missionId,
						executionId: recovery.executionId,
					};
		const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
		const pending = listPendingExecutorModelRecoveries(context.cwd, projectTrusted).find(
			(candidate) =>
				candidate.execution.executionId === attention.executionId &&
				candidate.mission.missionId === attention.missionId,
		);
		if (pending === undefined || attention.missionId === undefined || attention.executionId === undefined) {
			throw new Error("The failed Executor recovery is no longer current.");
		}
		const models = availableExecutorModels(context).filter((model) => model.id !== pending.execution.model);
		if (models.length === 0) {
			throw new Error("No alternate authenticated Executor model is available.");
		}
		const selected = await selectNativeExecutorModel(context, pending.execution.model);
		if (selected === undefined) {
			return false;
		}
		await recordUserExecutorModelRecovery({
			projectPath: context.cwd,
			projectTrusted,
			pending,
			model: selected,
			availableModels: availableExecutorModelIds(context),
		});
		await executeAttentionWorkerAction(attention, "continue-current-mission", context, controller, selected);
		return true;
	} catch (error) {
		context.ui.notify(errorMessage(error), "error");
		return false;
	}
}

async function trySameModelRecovery(
	recovery: WorkAttention,
	context: ExtensionContext,
	controller?: KhalaAttentionController,
): Promise<boolean> {
	try {
		if (controller === undefined) {
			throw new Error("The Khala Conclave is not available to perform this action.");
		}
		const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
		const pending = listPendingExecutorModelRecoveries(context.cwd, projectTrusted).find(
			(candidate) =>
				candidate.execution.executionId === recovery.executionId && candidate.mission.missionId === recovery.missionId,
		);
		const model = pending?.execution.model;
		if (pending === undefined || model === undefined) {
			throw new Error("The failed Executor model is no longer identifiable.");
		}
		const available = availableExecutorModelIds(context);
		if (!available.includes(model)) {
			throw new Error("The failed Executor model is not currently available.");
		}
		await recordUserExecutorModelRecovery({
			projectPath: context.cwd,
			projectTrusted,
			pending,
			model,
			availableModels: available,
		});
		await executeAttentionWorkerAction(recovery, "continue-current-mission", context, controller, model);
		return true;
	} catch (error) {
		context.ui.notify(errorMessage(error), "error");
		return false;
	}
}

async function showAttempts(item: WorkAttention, context: ExtensionContext): Promise<void> {
	const attempts = missionAttempts(item, context);
	if (attempts.length === 0) {
		context.ui.notify("No current Mission attempt history is available.", "info");
		return;
	}
	for (;;) {
		const selectedAttempt = await selectAttempt(item, attempts, context);
		if (selectedAttempt === undefined) {
			return;
		}
		await showKhalaDetails(context, attemptDetailTitle(item, selectedAttempt, context.ui.theme));
	}
}

type MissionAttempt = Readonly<{ number: number; execution: ExecutorRecord }>;

function selectAttempt(
	item: WorkAttention,
	attempts: readonly MissionAttempt[],
	_context: ExtensionContext,
): Promise<MissionAttempt | undefined> {
	const attemptNumberWidth = String(attempts.length).length;
	const executorWidth = Math.max(...attempts.map(({ execution }) => execution.executorName.length));
	return selectKhalaItem(
		_context,
		attemptsTitle(item, attempts.length),
		attempts.map((attempt) => ({
			value: attempt,
			label: attemptLabel(attempt, attemptNumberWidth, executorWidth),
			searchText: `${attempt.number} ${attempt.execution.executorName} ${attemptStatusTag(attempt.execution)} ${attempt.execution.executionId}`,
		})),
	);
}

function showKhalaDetails(context: ExtensionContext, title: string): Promise<void> {
	return context.ui.custom<void>((tui, theme, keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(title, 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("dim", keybindings.getKeys("tui.editor.deleteCharBackward").join("/")) +
					theme.fg("muted", " back  ") +
					theme.fg("dim", keybindings.getKeys("tui.select.cancel").join("/")) +
					theme.fg("muted", " close"),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (
					keybindings.matches(data, "tui.editor.deleteCharBackward") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					done();
					return;
				}
				tui.requestRender();
			},
		};
	});
}

function missionAttempts(item: WorkAttention, context: ExtensionContext): readonly MissionAttempt[] {
	if (item.missionId === undefined) {
		return [];
	}
	const executions = createArchiveSnapshot(
		context.cwd,
		typeof context.isProjectTrusted === "function" && context.isProjectTrusted(),
	)
		.listExecutions()
		.filter((execution) => execution.missionId === item.missionId && execution.kind !== "observer");
	const latest = new Map<string, ExecutorRecord>();
	for (const execution of executions) {
		latest.set(execution.executionId, execution);
	}
	return [...latest.values()].map((execution, index) => ({ number: index + 1, execution }));
}

function attemptsTitle(item: WorkAttention, count: number, theme?: Theme): string {
	return [
		`${item.title}  ${attentionTag("attempts", theme)}`,
		item.missionId === undefined ? undefined : `Mission       ${item.missionId}`,
		`Attempts      ${count}`,
		"Select an attempt",
	]
		.filter((value): value is string => value !== undefined)
		.join("\n");
}

function attemptLabel(
	attempt: MissionAttempt,
	attemptNumberWidth: number,
	executorWidth: number,
	theme?: Theme,
): string {
	const { execution } = attempt;
	const number = String(attempt.number).padStart(attemptNumberWidth, " ");
	const attemptText = `#${number}`;
	const executorText = execution.executorName.padEnd(executorWidth, " ");
	return `${theme?.fg("muted", attemptText) ?? attemptText}  ${theme?.fg("accent", executorText) ?? executorText}  ${attentionTag(attemptStatusTag(execution), theme)}`;
}

function attemptDetailTitle(item: WorkAttention, attempt: MissionAttempt, theme?: Theme): string {
	const { execution } = attempt;
	const lines = [
		`${item.title}  ${attentionTag(attemptStatusTag(execution), theme)}`,
		`Attempt       ${attempt.number}`,
		`Executor      ${execution.executorName}`,
		`Execution     ${execution.executionId}`,
		`Work          ${execution.workId}`,
		execution.missionId === undefined ? undefined : `Mission       ${execution.missionId}`,
		`Kind          ${execution.kind ?? "executor"}`,
		`Participant   ${metadataValue(execution.participantId)}`,
		`Status        ${execution.status}`,
		execution.status === ExecutorStatus.failed ? `Failure type  ${attemptFailureType(execution)}` : undefined,
		execution.failureMessage === undefined ? undefined : `Failure       ${metadataValue(execution.failureMessage)}`,
		`Model         ${metadataValue(execution.model)}`,
		`Launcher      ${metadataValue(execution.launcher)}`,
		`Started       ${metadataValue(execution.startedAt)}`,
		`Last signal   ${metadataValue(execution.lastSignalAt)}`,
		`Project       ${metadataValue(execution.projectPath)}`,
		`Sandbox       ${metadataValue(execution.sandboxPath)}`,
		execution.target === undefined ? undefined : `Target        ${metadataValue(execution.target)}`,
		execution.piSessionId === undefined ? undefined : `Pi session    ${metadataValue(execution.piSessionId)}`,
		execution.sessionPath === undefined ? undefined : `Session path  ${metadataValue(execution.sessionPath)}`,
		execution.recoveryOfExecutionId === undefined
			? undefined
			: `Recovery of   ${metadataValue(execution.recoveryOfExecutionId)}`,
		execution.recoveryRequestId === undefined
			? undefined
			: `Recovery req  ${metadataValue(execution.recoveryRequestId)}`,
		execution.promptIdentity === undefined
			? undefined
			: `Prompt package ${metadataValue(execution.promptIdentity.packageVersion)}`,
		execution.promptIdentity === undefined
			? undefined
			: `Prompt hash    ${metadataValue(execution.promptIdentity.promptSha256)}`,
		execution.upstreamBase === undefined
			? undefined
			: `Upstream remote ${metadataValue(execution.upstreamBase.remote)}`,
		execution.upstreamBase === undefined
			? undefined
			: `Upstream branch ${metadataValue(execution.upstreamBase.branch)}`,
		execution.upstreamBase === undefined
			? undefined
			: `Upstream head   ${metadataValue(execution.upstreamBase.headCommit)}`,
	].filter((value): value is string => value !== undefined);
	return lines.join("\n");
}

function attemptStatusTag(execution: ExecutorRecord): string {
	if (execution.status === ExecutorStatus.failed) return attemptFailureType(execution);
	return execution.status;
}

function attemptFailureType(execution: ExecutorRecord): string {
	if (execution.failureCategory === "model-unavailable") return "model unavailable";
	if (execution.failureMessage !== undefined) return "execution error";
	return "unknown failure";
}

function metadataValue(value: string | undefined): string {
	if (value === undefined) {
		return "not recorded";
	}
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length === 0 ? "not recorded" : normalized;
}

async function withAttentionLoader<T>(context: ExtensionContext, operation: () => Promise<T>): Promise<T> {
	context.ui.setWorkingVisible?.(true);
	try {
		return await operation();
	} finally {
		context.ui.setWorkingVisible?.(false);
	}
}

function workAttentionLabel(item: WorkAttention, theme?: Theme): string {
	const reference =
		item.pullRequestReference === undefined ? item.title : `${item.pullRequestReference}  ${item.title}`;
	return `${reference}  ${attentionTag(workAttentionTag(item), theme)}`;
}

function workAttentionTitle(item: WorkAttention, theme?: Theme): string {
	const lines = [
		`${item.title}  ${attentionTag(workAttentionTag(item), theme)}`,
		item.missionId === undefined ? undefined : `Mission       ${item.missionId}`,
		item.pullRequestReference === undefined ? undefined : `Pull Request  ${item.pullRequestReference}`,
		`${item.summary.includes("Mission is held") ? "Reason" : "Status"}        ${attentionDetail(item)}`,
	].filter((value): value is string => value !== undefined);
	return lines.join("\n");
}

function projectAttentionLabel(item: ProjectAttention, theme?: Theme): string {
	return `Khala project recovery  ${attentionTag(projectAttentionTag(item), theme)}`;
}

function projectAttentionTitle(item: ProjectAttention, theme?: Theme): string {
	return [
		`Khala project recovery  ${attentionTag(projectAttentionTag(item), theme)}`,
		`Status  ${compactProjectStatus(item)}`,
		item.summary,
	].join("\n");
}

function attentionTag(tag: string, theme?: Theme): string {
	const label = `[${tag}]`;
	return theme === undefined ? label : theme.fg("dim", label);
}

function workAttentionTag(item: WorkAttention): string {
	if (item.summary === "Ready for your review") return "review";
	if (item.summary.includes("Mission is held")) return "held";
	if (item.summary.includes("model is unavailable")) return "model unavailable";
	if (item.summary.includes("submission recovery")) return "stalled";
	if (item.summary.includes("worker failed")) return "failed";
	if (item.summary.includes("worker is available")) return "idle";
	if (item.summary.includes("could not be reached")) return "unreachable";
	if (
		item.summary.startsWith("Rejected by the Conclave:") ||
		item.summary.startsWith("Stopped after Conclave rejection")
	)
		return "rejected";
	return "attention";
}

function projectAttentionTag(item: ProjectAttention): string {
	return item.kind === "setup" ? "setup" : "stalled";
}

function attentionSummaryDetail(item: WorkAttention): string {
	return item.summary.includes("model is unavailable") ? item.summary : attentionDetail(item);
}

function attentionDetail(item: WorkAttention): string {
	if (item.summary.includes("model is unavailable")) {
		return "The current worker model is unavailable";
	}
	if (item.summary.startsWith("Rejected by the Conclave:")) {
		return `Rejected: ${item.summary.slice("Rejected by the Conclave:".length).trim()}`;
	}
	if (item.summary.startsWith("Stopped after Conclave rejection:")) {
		return `Rejected: ${item.summary.slice("Stopped after Conclave rejection:".length).trim()}`;
	}
	return item.summary;
}

function projectAttentionDetail(item: ProjectAttention): string {
	const [action] = item.actions;
	return action === undefined ? item.summary : `${item.summary}  ${projectActionLabel(action)}`;
}

function compactProjectStatus(item: ProjectAttention): string {
	if (item.kind === "setup") return "Setup required";
	return "Conclave recovery required";
}

function workActionLabel(action: WorkAttentionAction): string {
	if (action === "try-current-execution") return "Try current worker again";
	if (action === "continue-current-mission") return "Continue with a new worker";
	if (action === "stop-current-execution") return "Ask worker to stop";
	if (action === "select-model") return "Select another model";
	if (action === "try-same-model") return "Try the same model again";
	if (action === "review") return "Review";
	if (action === "view-attempts") return "View attempts";
	if (action === "recover-conclave") return "Recover Conclave";
	return "Dismiss";
}

function projectActionLabel(action: ProjectAttention["actions"][number]): string {
	if (action === "setup") return "Run setup";
	if (action === "recreate") return "Run /khala-recover";
	return "Dismiss";
}

function renderWorkerActionResult(status: string): string {
	if (status === "sent") return "The current worker continuation was sent.";
	if (status === "asked") return "The worker was asked to stop and must provide its blocked handoff.";
	if (status === "started") return "A new worker was started for the current Mission.";
	if (status === "already-active" || status === "already-sent" || status === "already-asked")
		return "That action was already applied or is already active.";
	if (status === "held") return "The current Mission is currently held; no worker was started.";
	if (status === "launch-failed") return "The replacement worker could not be started.";
	if (status === "stale") return "The Mission changed before Khala could apply the action.";
	if (status === "not-allowed") return "This action is not allowed for the current Mission.";
	if (status === "busy") return "The current worker is still busy.";
	if (status === "unreachable") return "The current worker could not be reached.";
	if (status === "unknown") return "Khala could not verify the current worker state.";
	if (status === "delivery-unknown") return "Khala could not confirm whether the action was delivered.";
	return "Khala could not apply the action.";
}

function workerActionLevel(status: string): "info" | "warning" | "error" {
	if (
		status === "sent" ||
		status === "asked" ||
		status === "started" ||
		status === "already-active" ||
		status === "already-sent" ||
		status === "already-asked"
	)
		return "info";
	if (status === "busy" || status === "held" || status === "unreachable" || status === "unknown") return "warning";
	return "error";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderAttentionError(error: unknown): string {
	const message = errorMessage(error).replace(ERROR_PREFIX_PATTERN, "");
	if (message.startsWith("Khala could not apply the action:")) {
		return "Khala could not apply the action.";
	}
	return message;
}

function observerOption(observer: KhalaObserverInspection, theme?: Theme): KhalaAttentionOption {
	return {
		label: `Inspect Observer pane: ${observer.executorName}  ${attentionTag("available", theme)}`,
		observer,
	};
}

export type { KhalaAttentionOption };
export { renderKhalaAttentionSummary, selectExecutorRecoveryModel, showKhalaAttention };
