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
	keybindings: KhalaConfig["keybindings"] = { help: "?", roleSettings: "r" },
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
		if (workId === "help") {
			await showHelp(context);
			continue;
		}
		if (workId === "settings") {
			if (roleSettings !== undefined) await showRoleSettings(roleSettings, context);
			continue;
		}
		await showWork(service, context, workId, actor);
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
): Promise<string | "help" | "settings" | null> {
	return context.ui.custom<string | "help" | "settings" | null>((tui, theme, _keybindings, done) => {
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
		const finish = (value: string | "help" | "settings" | null): void => {
			pickerState.query = input.getValue();
			if (value !== null && value !== "help" && value !== "settings") {
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
				if (input.getValue().length === 0 && parseKey(data) === keybindings.help) {
					finish("help");
					return;
				}
				if (input.getValue().length === 0 && parseKey(data) === keybindings.roleSettings) {
					finish("settings");
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

const NAVIGATION_FOOTER = "↑↓ navigate  enter select  escape/ctrl+c cancel";
type WorkSection = "actions" | "evidence" | "archive" | "review-comments" | "blocking-signal";

async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
): Promise<"back"> {
	for (;;) {
		const work = await service.inspectRuntime(workId);
		const records = readArchiveRecordsForNavigation(service, work, actor);
		const evidence = buildEvidencePresentation(work, records);
		const section = await pickSection(work, evidence, context);
		if (section === null || section === "back") return "back";
		if (section === "actions") {
			await chooseAction(service, context, work, actor);
			continue;
		}
		if (section === "evidence") {
			await showEvidence(service, work, context, actor);
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
): Promise<WorkSection | "back" | null> {
	const reviewComments = evidence.providerObservation?.details?.comments ?? [];
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		{ value: "archive", label: "Archive" },
		...(reviewComments.length === 0
			? []
			: [{ value: "review-comments", label: `Review comments (${reviewComments.length})` }]),
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
		container.addChild(new Text(theme.fg("dim", NAVIGATION_FOOTER), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(container, list, tui, () => done("back"));
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
		container.addChild(new Text(theme.fg("dim", NAVIGATION_FOOTER), 1, 0));
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
		await showTextPage(context, "Action failed", formatErrorLines(result.error));
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
		const footer = new Text("", 1, 0);
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Recovery")), 1, 0));
		container.addChild(body);
		container.addChild(new Spacer(1));
		container.addChild(footer);
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
): Component {
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => {
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

async function showReviewComments(evidence: EvidencePresentation, context: ExtensionContext): Promise<void> {
	const comments = evidence.providerObservation?.details?.comments ?? [];
	if (comments.length === 0) {
		await showTextPage(context, "Review comments", ["No provider review comments are available."]);
		return;
	}
	for (;;) {
		const selected = await selectReviewComment(comments, context);
		if (selected === null) return;
		const comment = comments[Number(selected)];
		if (comment === undefined) return;
		await showTextPage(context, "Review comment", formatReviewCommentLines(comment));
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
		container.addChild(new Text(theme.fg("dim", NAVIGATION_FOOTER), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		return selectableComponent(container, list, tui, () => done(null));
	});
}

function formatReviewCommentLines(comment: ProviderReviewComment): readonly string[] {
	const author = comment.author === undefined ? "unknown" : comment.author;
	const association = comment.authorAssociation === undefined ? "" : ` (${comment.authorAssociation})`;
	return [
		`author: ${author}${association}`,
		`created: ${comment.createdAt === undefined ? "unknown" : formatRecordedAt(comment.createdAt)}`,
		...(comment.state === undefined ? [] : [`state: ${comment.state}`]),
		...(comment.minimized === undefined ? [] : [`minimized: ${comment.minimized ? "yes" : "no"}`]),
		"",
		"Comment",
		comment.body,
		...(comment.url === undefined ? [] : ["", `url: ${comment.url}`]),
	];
}

async function showBlockingSignal(work: WorkView, context: ExtensionContext): Promise<void> {
	const signal = work.lastSignal;
	if (signal === undefined || signal.kind !== "blocked") {
		await showTextPage(context, "Blocking signal", ["No blocking Signal is available for this Work."]);
		return;
	}
	await showTextPage(context, "Blocking signal", formatSignalLines(signal));
}

function formatSignalLines(signal: Signal): readonly string[] {
	return [
		`observed: ${formatRecordedAt(signal.observedAt)}`,
		"",
		"Executor response",
		signal.summary,
		"",
		`Evidence (${signal.evidence.length})`,
		...(signal.evidence.length === 0 ? ["none"] : signal.evidence.map((item, index) => `${index + 1}. ${item}`)),
	];
}

async function showEvidence(
	service: ApplicationService,
	work: WorkView,
	context: ExtensionContext,
	actor: Actor,
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
	await showTextPage(context, "Evidence", formatEvidenceLines(presentation));
}

function formatEvidenceLines(presentation: EvidencePresentation): readonly string[] {
	const lines: string[] = [
		`evidence state: ${formatStatus(presentation.workState)}`,
		`active mission: ${formatMissionState(presentation.missionState ?? "not admitted")}`,
		`execution: ${formatPresentationExecutionState(presentation)}`,
		`runtime: ${formatStatus(presentation.runtimeState ?? "unavailable")}`,
		`activity: ${formatPresentationActivity(presentation)}`,
		`signal: ${presentation.signal.kind === "blocking-signal" ? "blocking signal" : presentation.signal.kind}`,
		`signal evidence: ${summarizeEvidenceCount(presentation.signal.evidenceCount)}`,
		`archive access: ${presentation.archive.accessLabel}`,
	];
	if (presentation.providerObservation === undefined) {
		lines.push("provider observation: none");
	} else {
		lines.push(...formatProviderEvidenceLines(presentation));
	}
	if (presentation.conclaveHandoff === undefined) {
		lines.push("conclave handoff: none recorded");
	} else {
		const handoff = presentation.conclaveHandoff;
		const target = handoff.executionId === undefined ? "new Execution" : `Execution ${handoff.executionId}`;
		const status = handoff.status === "delivered" ? "delivered" : `${handoff.status} for`;
		lines.push(`conclave handoff: ${status} ${target}`);
		lines.push(`handoff observation: ${handoff.observationId}`);
		lines.push(`handoff feedback (${handoff.feedback.length})`);
		lines.push(...handoff.feedback.map((item) => `- ${item}`));
	}
	lines.push(
		`review request: ${presentation.reviewRequest?.url ?? "none"}`,
		`review status: ${presentation.reviewRequest?.status ?? "none"}`,
		...formatErrorLines(presentation.error),
	);
	return lines;
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
	return `${count} evidence item${count === 1 ? "" : "s"}. Open Archive for details`;
}

function formatProviderEvidenceLines(presentation: EvidencePresentation): readonly string[] {
	const observation = presentation.providerObservation;
	if (observation === undefined) return ["provider observation: none"];
	const details = observation.details;
	if (details === undefined) {
		return [
			`provider observation: ${formatStatus(observation.kind)}`,
			`provider status: ${observation.status}`,
			`provider summary: ${presentEvidenceText(observation.summary)}`,
		];
	}
	const comments = details.comments;
	const checks = details.checks;
	return [
		`provider observation: ${formatStatus(observation.kind)}`,
		`provider status: ${observation.status}`,
		`provider summary: ${presentEvidenceText(observation.summary)}`,
		`PR status: ${providerPullRequestStatus(details.pullRequest.status, details.pullRequest.state)}`,
		`CI checks (${checks.length})`,
		...(checks.length === 0
			? ["none"]
			: checks.map((check) => {
					const result = check.conclusion === undefined ? check.status : `${check.status}/${check.conclusion}`;
					return `- ${check.name}: ${result}`;
				})),
		`review comments: ${comments.length === 0 ? "none" : `${comments.length} available — select Review comments to explore`}`,
	];
}

type RecordPage = Readonly<{ title: string; lines: readonly string[] }>;

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
			lines: [
				`from: ${capitalize(record.actor)}`,
				`recorded: ${formatRecordedAt(record.recordedAt)}`,
				"",
				"Executor response",
				response,
				"",
				`Evidence (${evidence.length})`,
				...(evidence.length === 0 ? ["none"] : evidence.map((item, index) => `${index + 1}. ${item}`)),
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
			lines: [
				`recorded: ${formatRecordedAt(record.recordedAt)}`,
				`summary: ${record.summary}`,
				`what failed: ${readObjectText(learning, "failure") ?? "not recorded"}`,
				`Mission specificity: ${readObjectText(learning, "missionSpecificity") ?? "not assessed"}`,
				`next Mission guidance: ${readObjectText(learning, "nextMissionGuidance") ?? "not recorded"}`,
			],
		};
	}
	const evidence = record.evidenceRefs;
	return {
		title: `Record ${record.sequence}: ${formatStatus(record.kind)}`,
		lines: [
			`actor: ${capitalize(record.actor)}`,
			`recorded: ${formatRecordedAt(record.recordedAt)}`,
			`summary: ${record.summary}`,
			`Evidence (${evidence.length})`,
			...(evidence.length === 0 ? ["none"] : evidence.map((item, index) => `${index + 1}. ${item}`)),
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
		lines: [
			`from: ${capitalize(record.actor)}`,
			`recorded: ${formatRecordedAt(record.recordedAt)}`,
			`provider: ${providerId}`,
			`status: ${status}`,
			`summary: ${record.summary}`,
			...(author === undefined ? [] : [`author: ${author}`]),
			...(reviewState === undefined ? [] : [`review state: ${reviewState}`]),
			...formatRawProviderDetails(readPayloadObject(record.payload, "details")),
			`feedback (${feedback.length})`,
			...(feedback.length === 0 ? ["none"] : feedback.map((item) => `- ${item}`)),
			"",
			`Evidence (${record.evidenceRefs.length})`,
			...(record.evidenceRefs.length === 0 ? ["none"] : record.evidenceRefs.map((item) => `- ${item}`)),
		],
	};
}

function providerPullRequestStatus(status: string, state: string): string {
	return status === "merged" ? "merged" : state;
}

function formatRawProviderDetails(details: JsonObject | undefined): readonly string[] {
	if (details === undefined) return [];
	const pullRequest = isJsonObject(details["pullRequest"]) ? details["pullRequest"] : undefined;
	const checks = readPayloadObjects(details, "checks");
	const comments = readPayloadObjects(details, "comments");
	return [
		...(pullRequest === undefined
			? []
			: [
					`PR status: ${providerPullRequestStatus(
						readObjectText(pullRequest, "status") ?? "unknown",
						readObjectText(pullRequest, "state") ?? "unknown",
					)}`,
				]),
		`CI checks (${checks.length})`,
		...(checks.length === 0
			? ["none"]
			: checks.map((check) => {
					const name = readObjectText(check, "name") ?? "unnamed";
					const checkStatus = readObjectText(check, "status") ?? "unknown";
					const conclusion = readObjectText(check, "conclusion");
					return `- ${name}: ${conclusion === undefined ? checkStatus : `${checkStatus}/${conclusion}`}`;
				})),
		`PR comments (${comments.length})`,
		...(comments.length === 0
			? ["none"]
			: comments.flatMap((comment, index) => {
					const author = readObjectText(comment, "author") ?? "unknown author";
					const association = readObjectText(comment, "authorAssociation");
					const body = readObjectText(comment, "body") ?? "No comment body.";
					return [
						`${index + 1}. ${author}${association === undefined ? "" : ` (${association})`}: ${body}`,
						...(readObjectText(comment, "url") === undefined ? [] : [`   ${readObjectText(comment, "url")}`]),
					];
				})),
	];
}

function formatOracleRecordPage(record: RecordView): RecordPage {
	const verdict = readPayloadText(record.payload, "verdict") ?? "unknown";
	const findings = readPayloadObjects(record.payload, "findings");
	const validationGaps = readPayloadTextList(record.payload, "validationGaps") ?? [];
	const output = readPayloadText(record.payload, "output");
	return {
		title: `Oracle response: ${capitalize(verdict)}`,
		lines: [
			`recorded: ${formatRecordedAt(record.recordedAt)}`,
			`verdict: ${capitalize(verdict)}`,
			`findings (${findings.length})`,
			...(findings.length === 0
				? ["none"]
				: findings.map((finding) => {
						const severity = readObjectText(finding, "severity") ?? "finding";
						const summary = readObjectText(finding, "summary") ?? "No summary provided.";
						return `- ${capitalize(severity)}: ${summary}`;
					})),
			`validation gaps (${validationGaps.length})`,
			...(validationGaps.length === 0 ? ["none"] : validationGaps.map((gap) => `- ${gap}`)),
			...(output === undefined ? [] : ["", "Model response", output]),
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

function formatErrorLines(error: ErrorEnvelope | undefined): readonly string[] {
	if (error === undefined) return ["error: none", "remediation: none", "learning: none"];
	return [
		"",
		"Error",
		presentEvidenceText(error.summary),
		"",
		"Next step",
		presentEvidenceText(error.remediation),
		`learning: ${presentEvidenceText(error.learning?.missionSpecificity ?? "none")}`,
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
		await showTextPage(context, page.title, page.lines);
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
		container.addChild(new Text(theme.fg("dim", NAVIGATION_FOOTER), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return selectableComponent(container, list, tui, () => done(null));
	});
}

async function showTextPage(context: ExtensionContext, title: string, lines: readonly string[]): Promise<void> {
	await context.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(new Text(theme.fg("muted", lines.join("\n")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "escape/ctrl+c/backspace back"), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
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

async function showHelp(context: ExtensionContext): Promise<void> {
	await showTextPage(context, "khala help", [
		"active means the lifecycle is open",
		"working means a prompt is running",
		"idle means waiting for the next Signal",
		"Type to filter  ? help  r role settings  enter select  escape/ctrl+c cancel",
	]);
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
