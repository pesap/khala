import {
	DynamicBorder,
	type ExtensionContext,
	type ModelRuntime,
	ModelSelectorComponent,
	type SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	fuzzyFilter,
	Input,
	matchesKey,
	parseKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { KhalaConfig } from "./config.js";
import { buildEvidencePresentation } from "./evidence.js";
import type {
	Action,
	Actor,
	ErrorEnvelope,
	EvidencePresentation,
	GovernedRole,
	JsonObject,
	JsonValue,
	ProviderObservation,
	ProviderReviewComment,
	RecordView,
	RecoveryUpdate,
	RoleSetting,
	RoleSettingsMap,
	Signal,
	WorkSummary,
	WorkView,
} from "./model.js";
import type { ApplicationService } from "./service.js";

export type RoleSettingsController = Readonly<{
	get: () => RoleSettingsMap;
	set: (role: GovernedRole, setting: RoleSetting, value: string) => void | Promise<void>;
}>;

const MAX_WORK_NAME_LENGTH = 36;
const WIDE_WORK_TABLE_COLUMNS = { title: 36, id: 21, state: 15, execution: 15 } as const;
type WorkTableLayout = Readonly<{ title: number; id?: number; state: number; execution: number }>;
type WorkStatusTone = "active" | "waiting" | "attention" | "failure" | "inactive" | "success";
type WorkStatus = Readonly<{ label: string; tone: WorkStatusTone }>;
type WorkStatusPalette = Readonly<Record<WorkStatusTone, (theme: Theme, text: string) => string>>;

// Labels communicate status without color; this palette only adds a semantic visual cue.
const WORK_STATUS_PALETTE = {
	active: (theme, text) => theme.fg("accent", text),
	waiting: (theme, text) => theme.fg("warning", text),
	attention: (theme, text) => theme.fg("warning", text),
	failure: (theme, text) => theme.fg("error", text),
	inactive: (theme, text) => theme.fg("muted", text),
	success: (theme, text) => theme.fg("success", text),
} satisfies WorkStatusPalette;

function isHiddenWork(item: WorkSummary): boolean {
	return item.state === "succeeded" || (item.state === "stopped" && item.stopReason !== "failed");
}

function workSearchText(item: WorkSummary): string {
	return [
		item.title,
		item.workId,
		item.state,
		item.stopReason ?? "",
		item.missionState ?? "not admitted",
		item.executionState ?? "not started",
		item.nextAction,
	].join(" ");
}

function truncateWorkName(value: string): string {
	const normalized = value.replace(/[\r\n]+/g, " ").trim();
	return normalized.length <= MAX_WORK_NAME_LENGTH
		? normalized
		: `${normalized.slice(0, MAX_WORK_NAME_LENGTH - 1).trimEnd()}…`;
}

function tableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function workTableLayout(width: number): WorkTableLayout {
	if (width >= 95) return WIDE_WORK_TABLE_COLUMNS;
	const available = Math.max(3, width - 6);
	const statusWidth = Math.min(15, Math.max(1, Math.floor((available - 1) / 3)));
	return { title: Math.max(1, available - statusWidth * 2), state: statusWidth, execution: statusWidth };
}

function hasWorkFailure(item: WorkSummary): boolean {
	return item.hasFailure === true || (item.state === "stopped" && item.stopReason === "failed");
}

function workState(item: WorkSummary): WorkStatus {
	if (item.state === "stopped" && item.stopReason === "failed") return { label: "stopped", tone: "failure" };
	if (item.state === "stopped") return { label: "stopped", tone: "inactive" };
	if (hasWorkFailure(item) && item.executionState !== "failed")
		return { label: `${formatStatus(item.state)} error`, tone: "failure" };
	if (item.state === "succeeded") return { label: "succeeded", tone: "success" };
	if (item.state === "queued" || item.state === "awaiting-review")
		return { label: formatStatus(item.state), tone: "waiting" };
	return { label: formatStatus(item.state), tone: "active" };
}

function executionState(item: WorkSummary): WorkStatus {
	const state = item.executionState;
	if (state === undefined) return { label: "not started", tone: "inactive" };
	if (state === "failed") return { label: "failed", tone: "failure" };
	if (state === "blocked") return { label: "blocked", tone: "attention" };
	if (state === "queued" || state === "awaiting-review") return { label: formatStatus(state), tone: "waiting" };
	if (state === "completed") return { label: "completed", tone: "success" };
	if (state === "stopped") return { label: "stopped", tone: "inactive" };
	return { label: "running", tone: "active" };
}

function workTableHeader(theme: Theme, layout: WorkTableLayout): string {
	const id = layout.id === undefined ? "" : `  ${tableCell("ID", layout.id)}`;
	return theme.fg("dim", `  ${tableCell("TITLE", layout.title)}${id}  ${tableCell("STATE", layout.state)}  EXECUTION`);
}

function workTableRow(theme: Theme, item: WorkSummary, selected: boolean, layout: WorkTableLayout): string {
	const prefix = selected ? theme.fg("accent", "→ ") : "  ";
	const title = tableCell(truncateWorkName(item.title), layout.title);
	const id = layout.id === undefined ? "" : `  ${theme.fg("dim", tableCell(item.workId, layout.id))}`;
	const state = workState(item);
	const execution = executionState(item);
	return `${prefix}${selected ? theme.fg("accent", title) : title}${id}  ${WORK_STATUS_PALETTE[state.tone](theme, tableCell(state.label, layout.state))}  ${WORK_STATUS_PALETTE[execution.tone](theme, execution.label)}`;
}

export async function showKhala(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor = "user",
	keybindings: KhalaConfig["keybindings"] = { roleSettings: "r", comments: "c" },
	roleSettings?: RoleSettingsController,
): Promise<void> {
	if (!context.hasUI || context.mode !== "tui") {
		context.ui.notify(renderDashboard(service.listWork()), "info");
		return;
	}
	const pickerState: WorkPickerState = { query: "" };
	for (;;) {
		const workId = await pickWork(service.listWork(), context, keybindings, pickerState);
		if (workId === null) return;
		if (workId === "settings") {
			if (roleSettings !== undefined) await showRoleSettings(roleSettings, context);
			continue;
		}
		await showWork(service, context, workId, actor, keybindings);
	}
}

type WorkPickerState = {
	query: string;
	selectedWorkId?: string | undefined;
};

async function pickWork(
	work: readonly WorkSummary[],
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
	pickerState: WorkPickerState,
): Promise<string | "settings" | null> {
	return context.ui.custom<string | "settings" | null>((tui, theme, _keybindings, done) => {
		const input = new Input();
		input.setValue(pickerState.query);
		let tableRows: readonly Readonly<{ item: WorkSummary; selected: boolean }>[] = [];
		let listMessages: readonly string[] = [];
		const listContainer: Component = {
			render: (width: number) => {
				const layout = workTableLayout(width);
				return [
					workTableHeader(theme, layout),
					...tableRows.map(({ item, selected }) => workTableRow(theme, item, selected, layout)),
					...listMessages,
				].map((line) => truncateToWidth(line, width, "…"));
			},
			invalidate: () => {},
		};
		let filtered = work.filter((item) => !isHiddenWork(item));
		let selectedIndex = 0;
		const updateList = (): void => {
			const rows: Array<Readonly<{ item: WorkSummary; selected: boolean }>> = [];
			const messages: string[] = [];
			const maxVisible = 10;
			const startIndex = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, filtered.length);
			for (let index = startIndex; index < endIndex; index += 1) {
				const item = filtered[index];
				if (item === undefined) continue;
				rows.push({ item, selected: index === selectedIndex });
			}
			if (startIndex > 0 || endIndex < filtered.length) {
				messages.push(theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`));
			}
			if (filtered.length === 0) {
				messages.push(theme.fg("muted", input.getValue() ? "  No matching Work" : "  No active Work"));
			}
			tableRows = rows;
			listMessages = messages;
			tui.requestRender();
		};
		const refresh = (restoreSelection = false): void => {
			const query = input.getValue();
			filtered =
				query.length === 0
					? work.filter((item) => !isHiddenWork(item))
					: fuzzyFilter(
							work.filter((item) => !isHiddenWork(item)),
							query,
							workSearchText,
						);
			const restoredIndex =
				restoreSelection && pickerState.selectedWorkId !== undefined
					? filtered.findIndex((item) => item.workId === pickerState.selectedWorkId)
					: -1;
			selectedIndex =
				restoredIndex >= 0
					? restoredIndex
					: query.length > 0
						? 0
						: Math.min(selectedIndex, Math.max(0, filtered.length - 1));
			updateList();
		};
		const finish = (value: string | "settings" | null): void => {
			pickerState.query = input.getValue();
			if (value !== null && value !== "settings") {
				pickerState.selectedWorkId = value;
			}
			done(value);
		};
		input.onSubmit = () => {
			const item = filtered[selectedIndex];
			if (item !== undefined) finish(item.workId);
		};
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Work")), 0, 0));
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, workPickerKeybindings(keybindings));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		refresh(true);
		let focused = false;
		return {
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				input.focused = value;
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (input.getValue().length === 0 && parseKey(data) === keybindings.roleSettings) {
					finish("settings");
					return;
				}
				if (matchesKey(data, "home")) {
					selectedIndex = 0;
					updateList();
					return;
				}
				if (matchesKey(data, "up") || matchesKey(data, "down")) {
					if (filtered.length === 0) return;
					selectedIndex = matchesKey(data, "up")
						? selectedIndex === 0
							? filtered.length - 1
							: selectedIndex - 1
						: selectedIndex === filtered.length - 1
							? 0
							: selectedIndex + 1;
					updateList();
					return;
				}
				if (matchesKey(data, "enter")) {
					const item = filtered[selectedIndex];
					if (item !== undefined) finish(item.workId);
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					finish(null);
					return;
				}
				if (matchesKey(data, "backspace") && input.getValue().length === 0) {
					finish(null);
					return;
				}
				input.handleInput(data);
				refresh();
			},
		};
	});
}

const NAVIGATION_FOOTER = "↑↓ navigate  enter select  escape/ctrl+c/backspace back";
const PANEL_BACK_FOOTER = "escape/ctrl+c/backspace back";

function workPickerKeybindings(keybindings: KhalaConfig["keybindings"]): string {
	return `${keybindings.roleSettings} Role Settings  ↑↓ Navigation  home First  enter Enter  escape Escape  backspace Backspace`;
}

function addPanelKeybindings(container: Container, theme: Theme, footer: string): Text {
	const keybindings = new Text(theme.fg("dim", footer), 1, 0);
	container.addChild(keybindings);
	container.addChild(new Spacer(1));
	return keybindings;
}

type WorkSection = "actions" | "evidence" | "archive" | "review-comments" | "blocking-signal";

async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
): Promise<"back"> {
	for (;;) {
		const work = await service.inspectRuntime(workId);
		const records = readArchiveRecordsForNavigation(service, work, actor);
		const evidence = buildEvidencePresentation(work, records);
		const section = await pickSection(work, evidence, context, keybindings);
		if (section === null || section === "back") return "back";
		if (section === "actions") {
			await chooseAction(service, context, work, actor);
			continue;
		}
		if (section === "evidence") {
			await showEvidence(service, work, context, actor, keybindings);
			continue;
		}
		if (section === "archive") {
			await showArchive(service, context, work, actor);
			continue;
		}
		if (section === "review-comments") {
			await showReviewComments(evidence, context);
			continue;
		}
		await showBlockingSignal(work, context);
	}
}

async function pickSection(
	work: WorkView,
	evidence: EvidencePresentation,
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
): Promise<WorkSection | "back" | null> {
	const reviewComments = providerReviewComments(evidence);
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		{ value: "archive", label: "Archive" },
		...(reviewComments.length === 0
			? []
			: [{ value: "review-comments", label: `Review comments (${reviewComments.length}) [${keybindings.comments}]` }]),
		...(work.execution?.state === "blocked" ? [{ value: "blocking-signal", label: "Inspect blocking signal" }] : []),
	];
	return context.ui.custom<WorkSection | "back" | null>((tui, theme, _keybindings, done) => {
		const mission = work.mission === undefined ? "not admitted" : formatMissionState(work.missionState ?? "unknown");
		const execution = work.execution;
		const failure =
			work.lastError !== undefined ||
			(work.state === "stopped" && work.stopReason === "failed") ||
			execution?.state === "failed";
		const status = [
			`Work ${failure ? theme.fg("error", formatWorkState(work)) : theme.bold(formatWorkState(work))}`,
			...(failure ? [`Failure ${theme.fg("error", "recorded. Inspect Evidence")}`] : []),
			`Mission ${mission}`,
			`Execution ${formatExecutionState(execution)}`,
			`Runtime ${formatRuntimeState(execution)}`,
			`Next: ${presentEvidenceText(work.nextAction)}`,
		];
		const summary = new Container();
		summary.addChild(new Text(theme.fg("accent", theme.bold(truncateWorkName(work.terms.title))), 1, 0));
		summary.addChild(new Text(theme.fg("muted", status.join("\n")), 1, 0));
		const list = new SelectList(items, items.length, selectorTheme(theme));
		list.onSelect = (item) => done(isWorkSection(item.value) ? item.value : "back");
		list.onCancel = () => done("back");
		const menu = new Container();
		menu.addChild(list);
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(summary);
		container.addChild(new Spacer(1));
		container.addChild(menu);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(
			container,
			list,
			tui,
			() => done("back"),
			(data) => {
				if (reviewComments.length === 0 || parseKey(data) !== keybindings.comments) return false;
				done("review-comments");
				return true;
			},
		);
	});
}

async function chooseAction(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<void> {
	const actions = service
		.availableActions(work.workId, actor, work.revision, work.execution?.runtimeState)
		.filter((action) => action.enabled);
	if (actions.length === 0) {
		await showTextPage(context, "Work action", ["No actions are currently available."]);
		return;
	}
	const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Work action")), 1, 0));
		const list = new SelectList(
			actions.map((action) => ({ value: action.id, label: displayActionLabel(action) })),
			actions.length,
			selectorTheme(theme),
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done("back");
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(container, list, tui, () => done("back"));
	});
	if (selected === null || selected === "back") return;
	const action = actions.find((candidate) => candidate.id === selected);
	if (action === undefined) return;
	if (action.kind === "recover") {
		await showRecovery(service, context, work, action);
		return;
	}
	const input = await actionInput(action, context);
	if (input === null) return;
	const result = await service.perform({
		action: action.kind,
		workId: work.workId,
		input,
		meta: { commandId: `tui:${action.id}`, actor, expectedWorkRevision: work.revision, schemaVersion: 1 },
	});
	if ("error" in result) {
		await showPage(context, "Action failed", formatErrorSections(result.error));
		return;
	}
	schedulePendingEffects(service);
	await showTextPage(context, "Action complete", [
		`action: ${displayActionLabel(action)}`,
		`next: ${withoutWork(result.value.nextAction)}`,
	]);
}

function withoutWork(value: string): string {
	return value
		.replace(/\bWork\b/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function displayActionLabel(action: Action): string {
	return withoutWork(action.label);
}

function schedulePendingEffects(service: ApplicationService): void {
	queueMicrotask(() => void service.processPendingEffects());
}

type RecoveryDisplay = Readonly<{
	status: "in progress" | "succeeded" | "failed";
	progress: string;
	doing: string;
	next: string;
	reason?: string | undefined;
}>;

async function showRecovery(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	action: Action,
): Promise<void> {
	await context.ui.custom<void>((tui, theme, _keybindings, done) => {
		let closed = false;
		let display: RecoveryDisplay = {
			status: "in progress",
			progress: "starting",
			doing:
				work.state === "stopped" && work.stopReason === "cancelled"
					? "Preparing a new attempt"
					: "Checking and restoring the Executor",
			next: "No action is needed  Keep this screen open until recovery finishes",
		};
		const body = new Text("", 1, 0);
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Recovery")), 1, 0));
		container.addChild(body);
		container.addChild(new Spacer(1));
		const footer = addPanelKeybindings(container, theme, "recovery is in progress");
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));

		const renderDisplay = (): void => {
			body.setText(
				theme.fg(
					"muted",
					[
						`status    ${display.status}`,
						`progress  ${display.progress}`,
						`doing     ${display.doing}`,
						display.reason === undefined ? undefined : `reason    ${display.reason}`,
						`next      ${display.next}`,
					]
						.filter((line): line is string => line !== undefined)
						.join("\n"),
				),
			);
			footer.setText(
				theme.fg("dim", display.status === "in progress" ? "recovery is in progress" : "escape/ctrl+c/backspace close"),
			);
			tui.requestRender();
		};
		const update = (next: RecoveryDisplay): void => {
			display = next;
			if (!closed) renderDisplay();
		};
		const onRecoveryUpdate = (progress: RecoveryUpdate): void => {
			update({
				status: "in progress",
				progress: `${formatStatus(progress.stage)}  ${withoutWork(progress.message)}`,
				doing: "Khala is restoring the Executor",
				next: "No action is needed  Keep this screen open until recovery finishes",
			});
		};
		renderDisplay();
		queueMicrotask(() => {
			void service
				.perform({
					action: action.kind,
					workId: work.workId,
					input: {},
					meta: {
						commandId: `tui:${action.id}`,
						actor: "user",
						expectedWorkRevision: work.revision,
						schemaVersion: 1,
					},
					onRecoveryUpdate,
				})
				.then((result) => {
					if ("error" in result) {
						update({
							status: "failed",
							progress: "stopped",
							doing: "Khala could not restore the Executor",
							reason: "The recovery operation could not be completed",
							next:
								result.error.code === "revision-conflict"
									? "Action needed  Refresh and try again"
									: "Action needed  Inspect Evidence for the failure details",
						});
						return;
					}
					schedulePendingEffects(service);
					const failed =
						(result.value.state === "stopped" && result.value.stopReason === "failed") ||
						result.value.execution?.state === "failed";
					const awaitingReview = result.value.execution?.state === "awaiting-review";
					update(
						failed
							? {
									status: "failed",
									progress: "stopped",
									doing: "Khala could not restore the Executor",
									reason: "The restored connection could not be confirmed",
									next: "Action needed  Inspect Evidence and decide what to do next",
								}
							: {
									status: "succeeded",
									progress: "complete",
									doing:
										work.state === "stopped" && work.stopReason === "cancelled"
											? "Returned to admission"
											: awaitingReview
												? "Executor restored and waiting for review"
												: "Executor restored and ready to continue",
									next:
										work.state === "stopped" && work.stopReason === "cancelled"
											? "No action needed  Khala will continue automatically"
											: awaitingReview
												? "Action needed  Review the Work when the provider responds"
												: "No action needed  Khala will continue automatically",
								},
					);
				})
				.catch(() =>
					update({
						status: "failed",
						progress: "stopped",
						doing: "Khala could not restore the Executor",
						reason: "The recovery operation ended unexpectedly",
						next: "Action needed  Inspect Evidence for the failure details",
					}),
				);
		});
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (display.status === "in progress") return;
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace")) {
					closed = true;
					done();
				}
			},
		};
	});
}

const ROLE_ORDER: readonly GovernedRole[] = ["conclave", "executor", "observer", "oracle"];
const ROLE_LABELS = {
	conclave: "Conclave",
	executor: "Executor",
	observer: "Observer",
	oracle: "Oracle",
} satisfies Readonly<Record<GovernedRole, string>>;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];
type NativeModelRuntimeAdapter = {
	getAvailableSnapshot: () => readonly PiModel[];
	getModel: (provider: string, modelId: string) => PiModel | undefined;
	getError: () => string | undefined;
	refresh: (...args: Parameters<ModelRuntime["refresh"]>) => ReturnType<ModelRuntime["refresh"]>;
};
type NativeSettingsManagerAdapter = {
	setDefaultModelAndProvider: (provider: string, modelId: string) => void;
};

function asNativeModelRuntime(value: NativeModelRuntimeAdapter): ModelRuntime {
	// SAFETY: ModelSelectorComponent only calls the model snapshot, lookup, error, and refresh methods supplied here.
	return value as ModelRuntime;
}

function asNativeSettingsManager(value: NativeSettingsManagerAdapter): SettingsManager {
	// SAFETY: ModelSelectorComponent only calls setDefaultModelAndProvider, which is intentionally a no-op here.
	return value as SettingsManager;
}

async function selectRoleModel(context: ExtensionContext, currentReference: string): Promise<PiModel | undefined> {
	const separator = currentReference.indexOf("/");
	const currentModel =
		separator <= 0
			? undefined
			: context.modelRegistry.find(currentReference.slice(0, separator), currentReference.slice(separator + 1));
	const modelRuntimeAdapter = {
		getAvailableSnapshot: () => context.modelRegistry.getAvailable(),
		getModel: (provider: string, modelId: string) => context.modelRegistry.find(provider, modelId),
		getError: () => context.modelRegistry.getError(),
		refresh: (...args: Parameters<ModelRuntime["refresh"]>) => context.modelRegistry.refresh(...args),
	};
	// The native selector persists the User's default model when a model is selected.
	// Khala role settings must not change the User's active Pi model.
	const settingsManager = {
		setDefaultModelAndProvider: (_provider: string, _modelId: string) => {},
	};
	const nativeModelRuntime = asNativeModelRuntime(modelRuntimeAdapter);
	const nativeSettingsManager = asNativeSettingsManager(settingsManager);
	return context.ui.custom<PiModel | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			currentModel,
			nativeSettingsManager,
			nativeModelRuntime,
			context.scopedModels,
			(model) => done(model),
			() => done(undefined),
		);
		return {
			render: (width: number) => selector.render(width),
			invalidate: () => selector.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "backspace") && selector.getSearchInput().getValue().length === 0) {
					selector.dispose();
					done(undefined);
					return;
				}
				selector.handleInput(data);
			},
			dispose: () => selector.dispose(),
		};
	});
}

async function selectRoleOption(
	context: ExtensionContext,
	title: string,
	options: string[],
): Promise<string | undefined> {
	const abortController = new AbortController();
	const unsubscribe = context.ui.onTerminalInput((data) => {
		if (!matchesKey(data, "backspace")) return;
		abortController.abort();
		return { consume: true };
	});
	try {
		return await context.ui.select(title, options, { signal: abortController.signal });
	} finally {
		unsubscribe();
	}
}

async function showRoleSettings(controller: RoleSettingsController, context: ExtensionContext): Promise<void> {
	for (;;) {
		const settings = controller.get();
		const roleOptions = ROLE_ORDER.map((role) => {
			const current = settings[role];
			return `${ROLE_LABELS[role]} — ${current.model || "model not configured"} (${current.thinking})`;
		});
		const selectedRole = await selectRoleOption(context, "Role settings:", roleOptions);
		if (selectedRole === undefined) return;
		const roleIndex = roleOptions.indexOf(selectedRole);
		const role = ROLE_ORDER[roleIndex];
		if (role === undefined) return;

		const current = controller.get()[role];
		const selectedSetting = await selectRoleOption(context, `${ROLE_LABELS[role]} settings:`, [
			`Model — ${current.model || "not configured"}`,
			`Thinking — ${current.thinking}`,
		]);
		if (selectedSetting === undefined) continue;
		const setting: RoleSetting = selectedSetting.startsWith("Model") ? "model" : "thinking";
		let value: string | undefined;
		if (setting === "model") {
			const selectedModel = await selectRoleModel(context, current.model);
			if (selectedModel === undefined) continue;
			value = `${selectedModel.provider}/${selectedModel.id}`;
		} else {
			const thinkingOptions = Array.from(new Set([current.thinking, ...THINKING_LEVELS]));
			value = await selectRoleOption(context, `${ROLE_LABELS[role]} thinking:`, thinkingOptions);
		}
		if (value === undefined) continue;
		try {
			await controller.set(role, setting, value);
			context.ui.notify(`${ROLE_LABELS[role]} ${setting} updated.`, "info");
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
}

function selectorTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function selectableComponent(
	container: Container,
	list: SelectList,
	tui: { requestRender(): void },
	onBack: () => void,
	interceptInput?: (data: string) => boolean,
): Component {
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
			if (interceptInput?.(data) === true) return;
			if (matchesKey(data, "backspace")) {
				onBack();
				return;
			}
			list.handleInput(data);
			tui.requestRender();
		},
	};
}

function isWorkSection(value: string): value is WorkSection {
	return (
		value === "actions" ||
		value === "evidence" ||
		value === "archive" ||
		value === "review-comments" ||
		value === "blocking-signal"
	);
}

function formatStatus(value: string): string {
	return value.replace(/-/g, " ");
}

function formatWorkState(work: WorkView): string {
	return work.state === "stopped" ? "stopped" : formatStatus(work.state);
}

function formatMissionState(value: string): string {
	return value === "active" ? "in progress" : formatStatus(value);
}

function formatExecutionState(execution: WorkView["execution"]): string {
	if (execution === undefined) return "not started";
	if (execution.state === "running" && execution.runtimeState === "unreachable") {
		return "running (no active runtime)";
	}
	return execution.state === "running" ? "running" : formatStatus(execution.state);
}

function formatRuntimeState(execution: WorkView["execution"]): string {
	if (execution === undefined) return "unavailable";
	const runtime = execution.runtimeState ?? "unknown";
	if (execution.state !== "blocked") return formatStatus(runtime);
	if (runtime === "working") return "finishing current turn";
	if (runtime === "pending") return "awaiting Conclave";
	if (runtime === "idle") return "idle (awaiting Conclave)";
	if (runtime === "unreachable") return "unreachable (awaiting Conclave)";
	return "unknown (awaiting Conclave)";
}

type PageSection = Readonly<{ heading?: string; lines: readonly string[] }>;
type RecordPage = Readonly<{ title: string; sections: readonly PageSection[] }>;

function pageSection(lines: readonly string[], heading?: string): PageSection {
	return heading === undefined ? { lines } : { heading, lines };
}

async function showReviewComments(evidence: EvidencePresentation, context: ExtensionContext): Promise<void> {
	const comments = providerReviewComments(evidence);
	if (comments.length === 0) {
		await showTextPage(context, "Review comments", ["No provider review comments are available."]);
		return;
	}
	for (;;) {
		const selected = await selectReviewComment(comments, context);
		if (selected === null) return;
		const comment = comments[Number(selected)];
		if (comment === undefined) return;
		await showPage(context, "Review comment", formatReviewCommentSections(comment));
	}
}

async function selectReviewComment(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const list = new SelectList(
			comments.map((comment, index) => ({
				value: String(index),
				label: `${comment.author ?? "unknown author"} — ${truncateToWidth(comment.body, 72, "…")}`,
			})),
			Math.min(6, comments.length),
			selectorTheme(theme),
		);
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Review comments")), 1, 0));
		container.addChild(new Text(theme.fg("muted", `${comments.length} provider comments`), 1, 0));
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		return selectableComponent(container, list, tui, () => done(null));
	});
}

function formatReviewCommentSections(comment: ProviderReviewComment): readonly PageSection[] {
	const author = comment.author === undefined ? "unknown" : comment.author;
	const association = comment.authorAssociation === undefined ? "" : ` (${comment.authorAssociation})`;
	return [
		pageSection([
			`author: ${author}${association}`,
			`created: ${comment.createdAt === undefined ? "unknown" : formatRecordedAt(comment.createdAt)}`,
			...(comment.source === undefined ? [] : [`source: ${comment.source}`]),
			...(comment.location === undefined ? [] : [`location: ${comment.location}`]),
			...(comment.state === undefined ? [] : [`state: ${comment.state}`]),
			...(comment.minimized === undefined ? [] : [`minimized: ${comment.minimized ? "yes" : "no"}`]),
		]),
		pageSection([comment.body], "Comment"),
		...(comment.url === undefined ? [] : [pageSection([`url: ${comment.url}`], "Source")]),
	];
}

async function showBlockingSignal(work: WorkView, context: ExtensionContext): Promise<void> {
	const signal = work.lastSignal;
	if (signal === undefined || signal.kind !== "blocked") {
		await showTextPage(context, "Blocking signal", ["No blocking Signal is available for this Work."]);
		return;
	}
	await showPage(context, "Blocking signal", formatSignalSections(signal));
}

function formatSignalSections(signal: Signal): readonly PageSection[] {
	return [
		pageSection([`observed: ${formatRecordedAt(signal.observedAt)}`]),
		...formatExecutorEvidenceSections(signal.summary, signal.evidence),
	];
}

function formatExecutorEvidenceSections(response: string, evidence: readonly string[]): readonly PageSection[] {
	return [
		pageSection([response], "Executor response"),
		pageSection(
			evidence.length === 0 ? ["none"] : evidence.map((item, index) => `${index + 1}. ${item}`),
			`Evidence (${evidence.length})`,
		),
	];
}

async function showEvidence(
	service: ApplicationService,
	work: WorkView,
	context: ExtensionContext,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
): Promise<void> {
	let records: readonly RecordView[];
	try {
		records = readAllArchiveRecords(service, work, actor);
	} catch (error) {
		await showTextPage(context, "Evidence", [
			`Unable to read Archive: ${error instanceof Error ? error.message : String(error)}`,
		]);
		return;
	}
	const presentation = buildEvidencePresentation(work, records);
	const comments = providerReviewComments(presentation);
	if (comments.length === 0) {
		await showPage(context, "Evidence", formatEvidenceSections(presentation));
		return;
	}
	for (;;) {
		const selected = await selectEvidenceSection(presentation, context, keybindings);
		if (selected !== "review-comments") return;
		await showReviewComments(presentation, context);
	}
}

type EvidenceSection = "review-comments";

async function selectEvidenceSection(
	presentation: EvidencePresentation,
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
): Promise<EvidenceSection | null> {
	const comments = providerReviewComments(presentation);
	return context.ui.custom<EvidenceSection | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		addPageContent(container, theme, "Evidence", formatEvidenceSections(presentation));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Review comments")), 1, 0));
		const list = new SelectList(
			[{ value: "review-comments", label: `${comments.length} available [${keybindings.comments}]` }],
			1,
			selectorTheme(theme),
		);
		list.onSelect = (item) => done(item.value === "review-comments" ? item.value : null);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(
			container,
			list,
			tui,
			() => done(null),
			(data) => {
				if (parseKey(data) !== keybindings.comments) return false;
				done("review-comments");
				return true;
			},
		);
	});
}

function providerReviewComments(presentation: EvidencePresentation): readonly ProviderReviewComment[] {
	return presentation.providerObservation?.details?.comments ?? [];
}

function formatEvidenceSections(presentation: EvidencePresentation): readonly PageSection[] {
	const sections: PageSection[] = [
		pageSection([
			`evidence state: ${formatStatus(presentation.workState)}`,
			`active mission: ${formatMissionState(presentation.missionState ?? "not admitted")}`,
			`execution: ${formatPresentationExecutionState(presentation)}`,
			`runtime: ${formatStatus(presentation.runtimeState ?? "unavailable")}`,
			`activity: ${formatPresentationActivity(presentation)}`,
			`signal: ${presentation.signal.kind === "blocking-signal" ? "blocking signal" : presentation.signal.kind}`,
			`signal evidence: ${summarizeEvidenceCount(presentation.signal.evidenceCount)}`,
			`archive access: ${presentation.archive.accessLabel}`,
		]),
		...formatProviderEvidenceSections(presentation),
	];
	if (presentation.conclaveHandoff === undefined) {
		sections.push(pageSection(["conclave handoff: none recorded"], "Conclave handoff"));
	} else {
		const handoff = presentation.conclaveHandoff;
		const target = handoff.executionId === undefined ? "new Execution" : `Execution ${handoff.executionId}`;
		const status = handoff.status === "delivered" ? "delivered" : `${handoff.status} for`;
		sections.push(
			pageSection(
				[
					`conclave handoff: ${status} ${target}`,
					`handoff observation: ${handoff.observationId}`,
					`handoff feedback (${handoff.feedback.length})`,
					...handoff.feedback.map((item) => `- ${item}`),
				],
				"Conclave handoff",
			),
		);
	}
	sections.push(
		pageSection(
			[
				`review request: ${presentation.reviewRequest?.url ?? "none"}`,
				`review status: ${presentation.reviewRequest?.status ?? "none"}`,
			],
			"Review request",
		),
		...formatErrorSections(presentation.error),
	);
	return sections;
}

function formatProviderEvidenceSections(presentation: EvidencePresentation): readonly PageSection[] {
	const observation = presentation.providerObservation;
	if (observation === undefined) {
		return [pageSection(["provider observation: none"], "Provider evidence")];
	}
	return [
		pageSection(
			[`provider observation: ${formatStatus(observation.kind)}`, `provider status: ${observation.status}`],
			"Provider observation",
		),
		pageSection(
			formatProviderSummaryLines(observation.summary, formatProviderFactsFromDetails(observation.details)),
			"Provider summary",
		),
	];
}

function formatPresentationExecutionState(presentation: EvidencePresentation): string {
	if (presentation.executionState === undefined) return "not started";
	if (presentation.executionState === "running" && !presentation.executionActive) {
		return "running (no active runtime)";
	}
	return presentation.executionState === "running" ? "running" : formatStatus(presentation.executionState);
}

function formatPresentationActivity(presentation: EvidencePresentation): string {
	if (presentation.activity === "execution-recorded" && presentation.runtimeState === "unreachable") {
		return "execution recorded (runtime unreachable, no active turn)";
	}
	return formatStatus(presentation.activity);
}

function summarizeEvidenceCount(count: number): string {
	if (count === 0) return "none";
	return `${count} evidence item${count === 1 ? "" : "s"}`;
}

function archiveLabel(record: RecordView): string {
	if (record.kind !== "signal") return `#${record.sequence} ${formatStatus(record.kind)}`;
	const kind = readPayloadText(record.payload, "kind") ?? "signal";
	return `#${record.sequence} Signal: ${capitalize(kind)}`;
}

function formatRecordPage(record: RecordView): RecordPage {
	if (record.kind === "signal") {
		const kind = readPayloadText(record.payload, "kind") ?? "signal";
		const response = readPayloadText(record.payload, "summary") ?? record.summary;
		const evidence = readPayloadTextList(record.payload, "evidence") ?? record.evidenceRefs;
		return {
			title: `Signal: ${capitalize(kind)}`,
			sections: [
				pageSection([`from: ${capitalize(record.actor)}`, `recorded: ${formatRecordedAt(record.recordedAt)}`]),
				...formatExecutorEvidenceSections(response, evidence),
			],
		};
	}
	if (record.kind === "observation" && isProviderObservationPayload(record.payload)) {
		return formatProviderObservationPage(record);
	}
	if (record.kind === "oracle-review") {
		return formatOracleRecordPage(record);
	}
	const learning =
		isJsonObject(record.payload) && isJsonObject(record.payload["learning"]) ? record.payload["learning"] : undefined;
	if (record.kind === "error" && learning !== undefined) {
		return {
			title: `Execution learning: ${record.sequence}`,
			sections: [
				pageSection([`recorded: ${formatRecordedAt(record.recordedAt)}`, `summary: ${record.summary}`]),
				pageSection(
					[
						`what failed: ${readObjectText(learning, "failure") ?? "not recorded"}`,
						`Mission specificity: ${readObjectText(learning, "missionSpecificity") ?? "not assessed"}`,
					],
					"Failure analysis",
				),
				pageSection(
					[`next Mission guidance: ${readObjectText(learning, "nextMissionGuidance") ?? "not recorded"}`],
					"Next Mission guidance",
				),
			],
		};
	}
	const evidence = record.evidenceRefs;
	return {
		title: `Record ${record.sequence}: ${formatStatus(record.kind)}`,
		sections: [
			pageSection([
				`actor: ${capitalize(record.actor)}`,
				`recorded: ${formatRecordedAt(record.recordedAt)}`,
				`summary: ${record.summary}`,
			]),
			pageSection(
				evidence.length === 0 ? ["none"] : evidence.map((item, index) => `${index + 1}. ${item}`),
				`Evidence (${evidence.length})`,
			),
		],
	};
}

function formatProviderObservationPage(record: RecordView): RecordPage {
	const kind = readPayloadText(record.payload, "kind") ?? "provider observation";
	const providerId = readPayloadText(record.payload, "providerId") ?? "unknown";
	const status = readPayloadText(record.payload, "status") ?? "unknown";
	const feedback = readPayloadTextList(record.payload, "feedback") ?? [];
	const author = readPayloadText(record.payload, "author");
	const reviewState = readPayloadText(record.payload, "reviewState");
	return {
		title: `Provider observation: ${formatStatus(kind)}`,
		sections: [
			pageSection([
				`from: ${capitalize(record.actor)}`,
				`recorded: ${formatRecordedAt(record.recordedAt)}`,
				`provider: ${providerId}`,
				`status: ${status}`,
			]),
			pageSection(
				formatProviderSummaryLines(
					readPayloadText(record.payload, "summary") ?? record.summary,
					formatProviderFactsFromPayload(readPayloadObject(record.payload, "details"), "unknown"),
				),
				"Provider summary",
			),
			...(author === undefined && reviewState === undefined
				? []
				: [
						pageSection(
							[
								...(author === undefined ? [] : [`author: ${author}`]),
								...(reviewState === undefined ? [] : [`review state: ${reviewState}`]),
							],
							"Review context",
						),
					]),
			...formatProviderDetailSections(readPayloadObject(record.payload, "details")),
			pageSection(
				feedback.length === 0 ? ["none"] : feedback.map((item) => `- ${item}`),
				`feedback (${feedback.length})`,
			),
			pageSection(
				record.evidenceRefs.length === 0 ? ["none"] : record.evidenceRefs.map((item) => `- ${item}`),
				`Evidence (${record.evidenceRefs.length})`,
			),
		],
	};
}

function providerPullRequestStatus(status: string, state: string): string {
	return status === "merged" ? "merged" : state;
}

type ProviderCheckSummary = Readonly<{ status: string; conclusion?: string | undefined }>;
type ProviderFacts = Readonly<{
	pullRequestStatus: string;
	checks: readonly ProviderCheckSummary[];
}>;

function formatProviderSummaryLines(summary: string, facts: ProviderFacts | undefined): readonly string[] {
	const payload = parseJsonObject(summary);
	if (payload === undefined) {
		if (looksLikeStructuredProviderSummary(summary)) {
			return facts === undefined
				? ["Provider returned structured evidence."]
				: formatProviderFacts(facts.pullRequestStatus, facts.checks);
		}
		return facts === undefined
			? [presentEvidenceText(summary)]
			: [presentEvidenceText(summary), ...formatProviderFacts(facts.pullRequestStatus, facts.checks)];
	}
	const payloadFacts = facts ?? formatProviderFactsFromPayload(payload, "unknown");
	return formatProviderFacts(payloadFacts?.pullRequestStatus ?? "unknown", payloadFacts?.checks ?? []);
}

function formatProviderFactsFromDetails(details: ProviderObservation["details"]): ProviderFacts | undefined {
	if (details === undefined) return undefined;
	return {
		pullRequestStatus: providerPullRequestStatus(details.pullRequest.status, details.pullRequest.state),
		checks: details.checks,
	};
}

function formatProviderFactsFromPayload(
	payload: JsonObject | undefined,
	fallbackStatus: string,
): ProviderFacts | undefined {
	if (payload === undefined) return undefined;
	const normalizedChecks = readPayloadObjects(payload, "checks");
	return {
		pullRequestStatus: providerPullRequestStatusFromPayload(payload, fallbackStatus),
		checks: providerCheckSummariesFromPayload(payload, normalizedChecks.length > 0 ? "checks" : "statusCheckRollup"),
	};
}

function providerCheckSummariesFromPayload(
	payload: JsonObject,
	key: "checks" | "statusCheckRollup" = "statusCheckRollup",
): readonly ProviderCheckSummary[] {
	return readPayloadObjects(payload, key).map((check) => {
		const status = readObjectText(check, "status") ?? readObjectText(check, "state") ?? "unknown";
		const conclusion = readObjectText(check, "conclusion");
		return conclusion === undefined ? { status } : { status, conclusion };
	});
}

function providerCommentCountFromPayload(payload: JsonObject): number {
	return providerEntryCount(payload["comments"]) + providerEntryCount(payload["reviews"]);
}

function providerEntryCount(value: JsonValue | undefined): number {
	if (Array.isArray(value)) return value.length;
	return isJsonNumber(value) && value >= 0 ? value : 0;
}

function formatProviderFacts(status: string, checks: readonly ProviderCheckSummary[]): readonly string[] {
	return [`PR status: ${status}`, formatProviderCheckSummary(checks)];
}

function formatProviderCheckSummary(checks: readonly ProviderCheckSummary[]): string {
	if (checks.length === 0) return "CI checks (0): none";
	const result = (check: ProviderCheckSummary): string => (check.conclusion ?? check.status).toLowerCase();
	const failed = checks.filter((check) => /fail|error|cancel|timed.?out/.test(result(check))).length;
	if (failed > 0) return `CI checks (${checks.length}): ${failed} failed`;
	const pending = checks.filter((check) => /pending|queued|progress|waiting|requested/.test(result(check))).length;
	if (pending > 0) return `CI checks (${checks.length}): ${pending} pending`;
	const unknown = checks.filter((check) => !/success|pass|complete|neutral|skip/.test(result(check))).length;
	if (unknown > 0) return `CI checks (${checks.length}): ${unknown} unknown`;
	const passing = checks.filter((check) => /success|pass/.test(result(check))).length;
	return passing === checks.length ? `CI checks (${checks.length}): passing` : `CI checks (${checks.length}): complete`;
}

function providerPullRequestStatusFromPayload(payload: JsonObject, fallbackStatus: string): string {
	const pullRequest = isJsonObject(payload["pullRequest"]) ? payload["pullRequest"] : undefined;
	if (pullRequest !== undefined) {
		return providerPullRequestStatus(
			readObjectText(pullRequest, "status") ?? fallbackStatus,
			readObjectText(pullRequest, "state") ?? "unknown",
		);
	}
	if (isTextValue(payload["mergedAt"])) return "merged";
	if (payload["isDraft"] === true) return "draft";
	const state = readObjectText(payload, "state");
	return state === undefined ? fallbackStatus : state.toLowerCase();
}

function formatProviderDetailSections(details: JsonObject | undefined): readonly PageSection[] {
	if (details === undefined) return [];
	const pullRequest = isJsonObject(details["pullRequest"]) ? details["pullRequest"] : undefined;
	const normalizedChecks = readPayloadObjects(details, "checks");
	const checks = normalizedChecks.length > 0 ? normalizedChecks : readPayloadObjects(details, "statusCheckRollup");
	const comments = [...readPayloadObjects(details, "comments"), ...readPayloadObjects(details, "reviews")];
	const commentCount = providerCommentCountFromPayload(details);
	const sections: PageSection[] = [];
	if (pullRequest !== undefined) {
		sections.push(
			pageSection(
				[
					`PR status: ${providerPullRequestStatus(
						readObjectText(pullRequest, "status") ?? "unknown",
						readObjectText(pullRequest, "state") ?? "unknown",
					)}`,
				],
				"Pull request",
			),
		);
	}
	sections.push(
		pageSection(checks.length === 0 ? ["none"] : checks.map(formatProviderCheck), `CI checks (${checks.length})`),
		pageSection(
			comments.length === 0
				? commentCount === 0
					? ["none"]
					: ["details unavailable"]
				: comments.flatMap(formatProviderComment),
			`PR comments (${commentCount})`,
		),
	);
	return sections;
}

function formatProviderCheck(check: JsonObject): string {
	const name = readObjectText(check, "name") ?? "unnamed";
	const status = readObjectText(check, "status") ?? readObjectText(check, "state") ?? "unknown";
	const conclusion = readObjectText(check, "conclusion");
	return `- ${name}: ${conclusion === undefined ? status : `${status}/${conclusion}`}`;
}

function formatProviderComment(comment: JsonObject, index: number): readonly string[] {
	const author = readObjectText(comment, "author") ?? "unknown author";
	const association = readObjectText(comment, "authorAssociation");
	const body = readObjectText(comment, "body") ?? "No comment body.";
	return [
		`${index + 1}. ${author}${association === undefined ? "" : ` (${association})`}: ${body}`,
		...(readObjectText(comment, "url") === undefined ? [] : [`   ${readObjectText(comment, "url")}`]),
	];
}

function formatOracleRecordPage(record: RecordView): RecordPage {
	const verdict = readPayloadText(record.payload, "verdict") ?? "unknown";
	const findings = readPayloadObjects(record.payload, "findings");
	const validationGaps = readPayloadTextList(record.payload, "validationGaps") ?? [];
	const output = readPayloadText(record.payload, "output");
	return {
		title: `Oracle response: ${capitalize(verdict)}`,
		sections: [
			pageSection([`recorded: ${formatRecordedAt(record.recordedAt)}`, `verdict: ${capitalize(verdict)}`]),
			pageSection(
				findings.length === 0
					? ["none"]
					: findings.map((finding) => {
							const severity = readObjectText(finding, "severity") ?? "finding";
							const summary = readObjectText(finding, "summary") ?? "No summary provided.";
							return `- ${capitalize(severity)}: ${summary}`;
						}),
				`findings (${findings.length})`,
			),
			pageSection(
				validationGaps.length === 0 ? ["none"] : validationGaps.map((gap) => `- ${gap}`),
				`validation gaps (${validationGaps.length})`,
			),
			...(output === undefined ? [] : [pageSection([output], "Model response")]),
		],
	};
}

function isProviderObservationPayload(payload: JsonValue): boolean {
	if (!isJsonObject(payload)) return false;
	const kind = payload["kind"];
	return (
		isTextValue(payload["observationId"]) &&
		isTextValue(payload["providerId"]) &&
		isTextValue(payload["status"]) &&
		isTextValue(kind) &&
		["ci-status", "review-comment", "feedback-delivery", "monitor-failure", "provider-outcome"].includes(kind)
	);
}

function readPayloadText(payload: JsonValue, key: string): string | undefined {
	return isJsonObject(payload) ? readObjectText(payload, key) : undefined;
}

function readPayloadObject(payload: JsonValue, key: string): JsonObject | undefined {
	if (!isJsonObject(payload)) return undefined;
	return isJsonObject(payload[key]) ? payload[key] : undefined;
}

function readObjectText(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return isTextValue(value) ? value : undefined;
}

function readPayloadTextList(payload: JsonValue, key: string): readonly string[] | undefined {
	if (!isJsonObject(payload)) return undefined;
	const value = payload[key];
	return Array.isArray(value) && value.every(isTextValue) ? value : undefined;
}

function readPayloadObjects(payload: JsonValue, key: string): readonly JsonObject[] {
	if (!isJsonObject(payload)) return [];
	const value = payload[key];
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function formatRecordedAt(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function formatErrorSections(error: ErrorEnvelope | undefined): readonly PageSection[] {
	if (error === undefined) return [pageSection(["error: none", "remediation: none", "learning: none"], "Error")];
	return [
		pageSection([presentEvidenceText(error.summary)], "Error"),
		pageSection(
			[
				presentEvidenceText(error.remediation),
				`learning: ${presentEvidenceText(error.learning?.missionSpecificity ?? "none")}`,
			],
			"Next step",
		),
	];
}

function presentEvidenceText(value: string): string {
	return value
		.split(";")
		.map((part, index) => {
			const text = part.trim();
			return index === 0 ? text : capitalize(text);
		})
		.filter((part) => part.length > 0)
		.join(". ");
}

function parseJsonObject(value: string): JsonObject | undefined {
	const parsed = parseJsonValue(value);
	return parsed !== undefined && isJsonObject(parsed) ? parsed : undefined;
}

function parseJsonValue(value: string): JsonValue | undefined {
	const candidate = structuredProviderSummaryText(value);
	if (candidate === undefined) return undefined;
	try {
		// SAFETY: JSON.parse only produces JSON primitives, arrays, and objects, which is JsonValue.
		return JSON.parse(candidate) as JsonValue;
	} catch {
		// A provider can truncate or wrap a JSON snapshot; the caller still suppresses its raw text.
		return undefined;
	}
}

function structuredProviderSummaryText(value: string): string | undefined {
	const normalized = normalizeProviderSummary(value);
	if (startsWithStructuredValue(normalized)) return normalized;
	const prefixed = normalized.match(
		/^(?:provider|github|gitlab|raw|json|payload|response|snapshot)[^\n:]{0,40}:\s*(.+)$/isu,
	);
	const candidate = prefixed?.[1]?.trim();
	return candidate !== undefined && startsWithStructuredValue(candidate) ? candidate : undefined;
}

function normalizeProviderSummary(value: string): string {
	return value
		.trim()
		.replace(/^```[^\n]*\n/iu, "")
		.replace(/\s*```$/u, "")
		.trim();
}

function startsWithStructuredValue(value: string): boolean {
	return (
		value.startsWith("{") ||
		value.startsWith("[") ||
		value.startsWith('"') ||
		/^(?:true|false|null|-?\d+(?:\.\d+)?)$/u.test(value)
	);
}

function looksLikeStructuredProviderSummary(value: string): boolean {
	const candidate = structuredProviderSummaryText(value);
	if (candidate === undefined) return false;
	if (parseJsonValue(value) !== undefined) return true;
	if (candidate.startsWith("{")) return true;
	return /^\[\s*(?:[{"]|$)/u.test(candidate) && hasStructuredProviderPrefix(value);
}

function hasStructuredProviderPrefix(value: string): boolean {
	const trimmed = value.trim();
	return (
		trimmed.startsWith("```") ||
		/^(?:provider|github|gitlab|raw|json|payload|response|snapshot)[^\n:]{0,40}:\s*/iu.test(trimmed)
	);
}

function isJsonNumber(value: JsonValue | undefined): value is number {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		value === Number(value) &&
		Number.isSafeInteger(value)
	);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function readArchiveRecordsForNavigation(
	service: ApplicationService,
	work: WorkView,
	actor: Actor,
): readonly RecordView[] {
	try {
		return readAllArchiveRecords(service, work, actor);
	} catch {
		return [];
	}
}

function readAllArchiveRecords(service: ApplicationService, work: WorkView, actor: Actor): readonly RecordView[] {
	const records: RecordView[] = [];
	let cursor: string | undefined;
	do {
		const page = service.readRecords(
			{ workId: work.workId },
			{ actor, commandId: `tui:archive:${work.workId}:${work.revision}`, schemaVersion: 1 },
			cursor,
		);
		records.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return records;
}

async function showArchive(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<void> {
	let records: readonly RecordView[];
	try {
		records = readAllArchiveRecords(service, work, actor);
	} catch (error) {
		await showTextPage(context, "Archive", [
			`Unable to read Archive: ${error instanceof Error ? error.message : String(error)}`,
		]);
		return;
	}
	if (records.length === 0) {
		await showTextPage(context, "Archive", ["No Archive records are available for this Work."]);
		return;
	}
	for (;;) {
		const selected = await selectArchiveRecord(records, context);
		if (selected === null || selected === "back") return;
		const record = records.find((candidate) => String(candidate.sequence) === selected);
		if (record === undefined) return;
		const page = formatRecordPage(record);
		await showPage(context, page.title, page.sections);
	}
}

async function selectArchiveRecord(records: readonly RecordView[], context: ExtensionContext): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Archive")), 1, 0));
		container.addChild(new Text(theme.fg("muted", `${records.length} Archive records`), 1, 0));
		const list = new SelectList(
			records.map((record) => ({ value: String(record.sequence), label: archiveLabel(record) })),
			Math.min(6, records.length),
			selectorTheme(theme),
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(container, list, tui, () => done(null));
	});
}

async function showTextPage(
	context: ExtensionContext,
	title: string,
	lines: readonly string[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await showPage(context, title, [pageSection(lines)], footer);
}

function addPageContent(container: Container, theme: Theme, title: string, sections: readonly PageSection[]): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const [index, section] of sections.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		if (section.heading !== undefined) {
			container.addChild(new Text(theme.fg("accent", theme.bold(section.heading)), 1, 0));
		}
		if (section.lines.length > 0) {
			container.addChild(new Text(theme.fg("muted", section.lines.join("\n")), 1, 0));
		}
	}
}

async function showPage(
	context: ExtensionContext,
	title: string,
	sections: readonly PageSection[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await context.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		addPageContent(container, theme, title, sections);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, footer);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace")) done();
			},
		};
	});
}

async function actionInput(action: Action, context: ExtensionContext): Promise<JsonObject | undefined | null> {
	if (action.kind === "record-review") {
		const status = await context.ui.select("Provider review result:", ["changes-requested", "merged", "closed"]);
		if (status === undefined) {
			return null;
		}
		const feedback = await context.ui.editor("Feedback, one item per line:", "");
		return {
			status,
			feedback: (feedback ?? "")
				.split("\n")
				.map((entry) => entry.trim())
				.filter((entry) => entry.length > 0),
		};
	}
	if (action.kind === "cancel") {
		const confirmed = await context.ui.confirm("Cancel?", "This records an explicit cancellation.");
		return confirmed ? {} : null;
	}
	if (action.kind === "fail-work") {
		const reason = await context.ui.input("Failure reason:", "");
		return reason === undefined ? null : { reason };
	}
	if (action.kind === "run-oracle") {
		const subject = await context.ui.input("Oracle review subject:", "Review this Work");
		return subject === undefined ? null : { subject };
	}
	if (action.kind === "rename-work") {
		const title = await context.ui.input("New Work title:", "");
		return title === undefined ? null : { title };
	}
	if (action.kind === "amend-budget") {
		const value = await context.ui.input("New maximum token budget:", "");
		if (value === undefined) {
			return null;
		}
		const maxTokens = Number(value);
		return Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : null;
	}
	return {};
}

function renderDashboard(work: readonly WorkSummary[]): string {
	if (work.length === 0) {
		return "Khala: no Work has been submitted.";
	}
	return [
		"Khala",
		...work.map((item) => `${item.state.padEnd(16)} ${item.title} (${item.workId}) — ${item.nextAction}`),
	].join("\n");
}
