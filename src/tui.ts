import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
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
	ScrollView,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	VStack,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { KhalaArchiveView } from "./archive-view.js";
import type { KhalaConfig } from "./config.js";
import type {
	Action,
	Actor,
	ErrorEnvelope,
	GovernedRole,
	JsonObject,
	JsonValue,
	ProviderReviewComment,
	RecordKind,
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
const MAX_RECORD_LIST_SUMMARY_LENGTH = 72;
const RECORD_LIST_COLUMNS = { sequence: 5, kind: 18, actor: 12, time: 26 } as const;
const WIDE_WORK_TABLE_COLUMNS = { title: 36, id: 10, state: 15, execution: 15, showId: true } as const;
type WorkTableLayout = Readonly<{ title: number; id: number; state: number; execution: number; showId: boolean }>;
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

function truncateWorkName(value: string): string {
	const normalized = value.replace(/[\r\n]+/g, " ").trim();
	return normalized.length <= MAX_WORK_NAME_LENGTH ? normalized : normalized.slice(0, MAX_WORK_NAME_LENGTH).trimEnd();
}

function tableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function selectionMarker(selected: boolean): string {
	return selected ? "→ " : "  ";
}
function workTableLayout(width: number): WorkTableLayout {
	if (width >= 95) return WIDE_WORK_TABLE_COLUMNS;
	const available = Math.max(1, width - 2);
	return available >= 33 ? mediumWorkTableLayout(available) : narrowWorkTableLayout(available);
}

function mediumWorkTableLayout(available: number): WorkTableLayout {
	const wide = available >= 43;
	const id = wide ? 8 : 6;
	const state = wide ? 10 : 7;
	return { title: Math.max(1, available - id - state - 15), id, state, execution: 9, showId: true };
}

function narrowWorkTableLayout(available: number): WorkTableLayout {
	const state = available >= 24 ? 6 : Math.max(1, Math.min(8, Math.floor((available - 4) / 4)));
	const execution =
		available >= 24 ? Math.min(9, Math.max(1, available - state - 8)) : narrowExecutionWidth(available, state);
	return { title: Math.max(1, available - state - execution - 4), id: 0, state, execution, showId: false };
}

function narrowExecutionWidth(available: number, state: number): number {
	return Math.max(1, Math.min(9, Math.floor((available - state - 4) / 2)));
}

function hasWorkFailure(item: WorkSummary): boolean {
	return item.hasFailure === true || (item.state === "stopped" && item.stopReason === "failed");
}
function workState(item: WorkSummary): WorkStatus {
	if (item.state === "stopped") return stoppedWorkStatus(item);
	if (hasWorkFailure(item)) return { label: "attention", tone: "failure" };
	if (item.state === "succeeded") return { label: "succeeded", tone: "success" };
	return { label: formatStatus(item.state), tone: workStatusTone(item.state) };
}

function workStatusTone(state: WorkSummary["state"]): WorkStatusTone {
	return state === "queued" || state === "awaiting-review" ? "waiting" : "active";
}

function stoppedWorkStatus(item: WorkSummary): WorkStatus {
	return item.stopReason === "failed" ? { label: "failed", tone: "failure" } : { label: "stopped", tone: "inactive" };
}
function executionState(item: WorkSummary): WorkStatus {
	const state = item.executionState;
	return state === undefined ? { label: "not started", tone: "inactive" } : executionStatus(state);
}

function executionStatus(state: NonNullable<WorkSummary["executionState"]>): WorkStatus {
	const statuses = {
		failed: { label: "failed", tone: "failure" },
		blocked: { label: "blocked", tone: "attention" },
		queued: { label: formatStatus(state), tone: "waiting" },
		"awaiting-review": { label: formatStatus(state), tone: "waiting" },
		completed: { label: "completed", tone: "success" },
		stopped: { label: "stopped", tone: "inactive" },
		running: { label: "running", tone: "active" },
	} satisfies Record<typeof state, WorkStatus>;
	return statuses[state];
}

function workTableHeader(theme: Theme, layout: WorkTableLayout): string {
	const id = layout.showId ? `  ${tableCell("ID", layout.id)}` : "";
	return theme.fg(
		"dim",
		`  ${tableCell("TITLE", layout.title)}${id}  ${tableCell("STATE", layout.state)}  ${tableCell("EXECUTION", layout.execution)}`,
	);
}

function shortId(value: string): string {
	return value.length <= 10 ? value : value.slice(0, 10);
}

function workTableRow(theme: Theme, item: WorkSummary, selected: boolean, layout: WorkTableLayout): string {
	const title = tableCell(truncateWorkName(item.title), layout.title);
	const id = layout.showId ? `  ${tableCell(shortId(item.workId), layout.id)}` : "";
	const state = workState(item);
	const execution = executionState(item);
	const row = `${title}${id}  ${WORK_STATUS_PALETTE[state.tone](theme, tableCell(state.label, layout.state))}  ${WORK_STATUS_PALETTE[execution.tone](theme, tableCell(execution.label, layout.execution))}`;
	const indented = `${selectionMarker(selected)}${row}`;
	return selected ? theme.fg("accent", theme.bold(indented)) : indented;
}
export async function showKhala(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor = "user",
	keybindings: KhalaConfig["keybindings"] = {
		roleSettings: "r",
		comments: "c",
		refresh: "ctrl+r",
		help: "?",
		history: "h",
	},
	roleSettings?: RoleSettingsController,
): Promise<void> {
	if (!isTuiContext(context)) {
		context.ui.notify(renderDashboard(service.listWork()), "info");
		return;
	}
	await runKhalaPicker(service, context, actor, keybindings, roleSettings);
}

export async function showKhalaArchive(archive: KhalaArchiveView, context: ExtensionContext): Promise<void> {
	if (!isTuiContext(context)) {
		context.ui.notify(renderDashboard(archive.listWork()), "info");
		return;
	}
	await runKhalaArchivePicker(archive, context);
}

function isTuiContext(context: ExtensionContext): boolean {
	return context.hasUI && context.mode === "tui";
}

async function runKhalaArchivePicker(archive: KhalaArchiveView, context: ExtensionContext): Promise<void> {
	const pickerState: WorkPickerState = { showHistory: true };
	const keybindings = normalizeKeybindings({
		roleSettings: "r",
		comments: "c",
		refresh: "ctrl+r",
		help: "?",
		history: "h",
	});
	for (;;) {
		const result = await pickWork(() => archive.listWork(), context, keybindings, pickerState, { showSettings: false });
		if (!(await handleArchivePickerResult(result, archive, context, keybindings))) return;
	}
}

async function handleArchivePickerResult(
	result: WorkPickerResult,
	archive: KhalaArchiveView,
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
): Promise<boolean> {
	if (result === null) return false;
	if (result === "help") {
		await showTextPage(context, "Work picker help", workPickerHelp(keybindings, false));
		return true;
	}
	if (result === "settings") return true;
	await showArchiveWork(archive, context, result);
	return true;
}

async function runKhalaPicker(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
	roleSettings: RoleSettingsController | undefined,
): Promise<void> {
	const pickerState: WorkPickerState = {};
	const effectiveKeybindings = normalizeKeybindings(keybindings);
	for (;;) {
		const result = await pickWork(() => service.listWork(), context, effectiveKeybindings, pickerState, {
			showSettings: true,
		});
		if (result === null) return;
		await handlePickerResult(result, service, context, actor, effectiveKeybindings, roleSettings);
	}
}

async function handlePickerResult(
	result: Exclude<WorkPickerResult, null>,
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
	roleSettings: RoleSettingsController | undefined,
): Promise<void> {
	if (result === "settings") {
		if (roleSettings !== undefined) await showRoleSettings(roleSettings, context);
		return;
	}
	if (result === "help") {
		await showTextPage(context, "Work picker help", workPickerHelp(keybindings));
		return;
	}
	await showWork(service, context, result, actor, keybindings);
}

type WorkPickerState = {
	selectedWorkId?: string | undefined;
	filter?: string | undefined;
	showHistory?: boolean | undefined;
};

type WorkPickerResult = string | "settings" | "help" | null;
type WorkPickerRow = Readonly<{ item: WorkSummary; selected: boolean }>;
type PickerWindow = Readonly<{ start: number; end: number }>;

type PickerInputHandlers = Readonly<{
	finish: (value: WorkPickerResult) => void;
	refresh: () => void;
	toggleHistory: () => void;
	home: () => void;
	move: (movingUp: boolean) => void;
	enter: () => void;
	updateFilter: () => void;
}>;
type PickerListSnapshot = Readonly<{ rows: readonly WorkPickerRow[]; messages: readonly string[] }>;

function pickerWindow(selectedIndex: number, length: number): PickerWindow {
	const maxVisible = 10;
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), length - maxVisible));
	return { start, end: Math.min(start + maxVisible, length) };
}

function pickerRows(
	filtered: readonly WorkSummary[],
	window: PickerWindow,
	selectedIndex: number,
): readonly WorkPickerRow[] {
	const rows: WorkPickerRow[] = [];
	for (let index = window.start; index < window.end; index += 1) {
		const item = filtered[index];
		if (item !== undefined) rows.push({ item, selected: index === selectedIndex });
	}
	return rows;
}

function pickerMessages(
	theme: Theme,
	availableWork: readonly WorkSummary[],
	filtered: readonly WorkSummary[],
	window: PickerWindow,
	selectedIndex: number,
	showHistory: boolean | undefined,
): readonly string[] {
	const messages: string[] = [];
	if (window.start > 0 || window.end < filtered.length)
		messages.push(theme.fg("muted", `  ${selectedIndex + 1} of ${filtered.length}`));
	if (filtered.length === 0) messages.push(theme.fg("muted", emptyPickerMessage(availableWork, showHistory)));
	return messages;
}

function pickerListSnapshot(
	theme: Theme,
	availableWork: readonly WorkSummary[],
	filtered: readonly WorkSummary[],
	selectedIndex: number,
	showHistory: boolean | undefined,
): PickerListSnapshot {
	const window = pickerWindow(selectedIndex, filtered.length);
	return {
		rows: pickerRows(filtered, window, selectedIndex),
		messages: pickerMessages(theme, availableWork, filtered, window, selectedIndex, showHistory),
	};
}

function pickerListContainer(
	theme: Theme,
	getRows: () => readonly WorkPickerRow[],
	getMessages: () => readonly string[],
): Component {
	return {
		render: (width: number) => {
			const layout = workTableLayout(width);
			return [
				workTableHeader(theme, layout),
				...getRows().map(({ item, selected }) => workTableRow(theme, item, selected, layout)),
				...getMessages(),
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate: () => {},
	};
}

function handlePickerInput(
	data: string,
	input: Input,
	keybindings: KhalaConfig["keybindings"],
	showSettings: boolean,
	handlers: PickerInputHandlers,
): void {
	const action = pickerInputAction(data, input, keybindings, showSettings);
	const actionHandlers = new Map<PickerInputAction, () => void>([
		["settings", () => handlers.finish("settings")],
		["help", () => handlers.finish("help")],
		["back", () => handlers.finish(null)],
		["refresh", handlers.refresh],
		["history", handlers.toggleHistory],
		["home", handlers.home],
		["up", () => handlers.move(true)],
		["down", () => handlers.move(false)],
		["enter", handlers.enter],
	]);
	const handler = actionHandlers.get(action);
	if (handler !== undefined) {
		handler();
		return;
	}
	const previousFilter = input.getValue();
	input.handleInput(data);
	if (input.getValue() !== previousFilter) handlers.updateFilter();
}

class WorkPickerController {
	private readonly getWork: () => readonly WorkSummary[];
	private readonly theme: Theme;
	private readonly requestRender: () => void;
	private readonly pickerState: WorkPickerState;
	private readonly done: (value: WorkPickerResult) => void;
	private availableWork: readonly WorkSummary[];
	private filtered: readonly WorkSummary[];
	private selectedIndex = 0;
	private setHistoryFooter: (showHistory: boolean) => void = () => {};

	constructor(
		getWork: () => readonly WorkSummary[],
		theme: Theme,
		requestRender: () => void,
		pickerState: WorkPickerState,
		done: (value: WorkPickerResult) => void,
	) {
		this.getWork = getWork;
		this.theme = theme;
		this.requestRender = requestRender;
		this.pickerState = pickerState;
		this.done = done;
		this.availableWork = pickerWork(getWork(), pickerState.showHistory === true);
		this.filtered = filterWork(this.availableWork, pickerState.filter ?? "");
		this.restoreSelection();
	}

	setFooter(update: (showHistory: boolean) => void): void {
		this.setHistoryFooter = update;
	}

	rows(): readonly WorkPickerRow[] {
		return pickerListSnapshot(
			this.theme,
			this.availableWork,
			this.filtered,
			this.selectedIndex,
			this.pickerState.showHistory,
		).rows;
	}

	messages(): readonly string[] {
		return pickerListSnapshot(
			this.theme,
			this.availableWork,
			this.filtered,
			this.selectedIndex,
			this.pickerState.showHistory,
		).messages;
	}

	updateList(): void {
		this.requestRender();
	}

	updateFilter(input: Input): void {
		const query = input.getValue().trim();
		this.pickerState.filter = query;
		this.filtered = filterWork(this.availableWork, query);
		this.selectedIndex = query.length === 0 ? Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1)) : 0;
		this.updateList();
	}

	refresh(input: Input): void {
		const selectedWorkId = this.filtered[this.selectedIndex]?.workId ?? this.pickerState.selectedWorkId;
		this.availableWork = pickerWork(this.getWork(), this.pickerState.showHistory === true);
		this.filtered = filterWork(this.availableWork, input.getValue().trim());
		this.selectedIndex = refreshedWorkIndex(selectedWorkId, this.filtered, this.selectedIndex);
		this.updateList();
	}

	finish(value: WorkPickerResult): void {
		if (value !== null && value !== "settings" && value !== "help") this.pickerState.selectedWorkId = value;
		this.done(value);
	}

	toggleHistory(input: Input): void {
		this.pickerState.showHistory = this.pickerState.showHistory !== true;
		this.availableWork = pickerWork(this.getWork(), this.pickerState.showHistory === true);
		this.filtered = filterWork(this.availableWork, input.getValue().trim());
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.setHistoryFooter(this.pickerState.showHistory === true);
		this.updateList();
	}

	move(movingUp: boolean): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = nextPickerIndex(this.selectedIndex, this.filtered.length, movingUp);
		this.updateList();
	}

	first(): void {
		this.selectedIndex = 0;
		this.updateList();
	}

	enter(): void {
		const item = this.filtered[this.selectedIndex];
		if (item !== undefined) this.finish(item.workId);
	}

	private restoreSelection(): void {
		const filter = this.pickerState.filter;
		const filterEmpty = filter === undefined || filter.trim().length === 0;
		const restoredIndex = restoredPickerIndex(filterEmpty, this.pickerState.selectedWorkId, this.filtered);
		if (restoredIndex !== undefined) this.selectedIndex = restoredIndex;
	}
}

function restoredPickerIndex(
	filterEmpty: boolean,
	selectedWorkId: string | undefined,
	filtered: readonly WorkSummary[],
): number | undefined {
	if (!filterEmpty) return undefined;
	const restoredIndex =
		selectedWorkId === undefined ? -1 : filtered.findIndex((item) => item.workId === selectedWorkId);
	return restoredIndex < 0 ? undefined : restoredIndex;
}

type FocusableComponent = Component & { focused: boolean };

function workPickerComponent(
	filterInput: Input,
	container: Container,
	keybindings: KhalaConfig["keybindings"],
	controller: WorkPickerController,
	showSettings: boolean,
): FocusableComponent {
	return {
		get focused() {
			return filterInput.focused;
		},
		set focused(value: boolean) {
			filterInput.focused = value;
		},
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) =>
			handlePickerInput(data, filterInput, keybindings, showSettings, {
				finish: (value) => controller.finish(value),
				refresh: () => controller.refresh(filterInput),
				toggleHistory: () => controller.toggleHistory(filterInput),
				home: () => controller.first(),
				move: (movingUp) => controller.move(movingUp),
				enter: () => controller.enter(),
				updateFilter: () => controller.updateFilter(filterInput),
			}),
	};
}

type WorkPickerOptions = Readonly<{ showSettings: boolean }>;

async function pickWork(
	getWork: () => readonly WorkSummary[],
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
	pickerState: WorkPickerState,
	options: WorkPickerOptions,
): Promise<WorkPickerResult> {
	return context.ui.custom<WorkPickerResult>((tui, theme, _keybindings, done) => {
		const filterInput = new Input();
		filterInput.focused = true;
		filterInput.setValue(pickerState.filter ?? "");
		const controller = new WorkPickerController(getWork, theme, () => tui.requestRender(), pickerState, done);
		const listContainer = pickerListContainer(
			theme,
			() => controller.rows(),
			() => controller.messages(),
		);
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Work")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(filterInput);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		const footer = addPanelKeybindings(
			container,
			theme,
			workPickerKeybindings(keybindings, pickerState.showHistory === true, options.showSettings),
		);
		controller.setFooter((showHistory) =>
			footer.setText(theme.fg("dim", workPickerKeybindings(keybindings, showHistory, options.showSettings))),
		);
		controller.updateList();
		return workPickerComponent(filterInput, container, keybindings, controller, options.showSettings);
	});
}

type PickerInputAction =
	| "settings"
	| "help"
	| "refresh"
	| "history"
	| "home"
	| "up"
	| "down"
	| "enter"
	| "back"
	| "type";

const PICKER_NAVIGATION_ACTIONS: ReadonlyMap<string | undefined, PickerInputAction> = new Map([
	["home", "home"],
	["up", "up"],
	["down", "down"],
	["enter", "enter"],
]);

function pickerInputAction(
	data: string,
	input: Input,
	keybindings: KhalaConfig["keybindings"],
	showSettings: boolean,
): PickerInputAction {
	const key = parseKey(data);
	const filterEmpty = input.getValue().trim().length === 0;
	if (filterEmpty) {
		const shortcut = pickerShortcut(key, keybindings, showSettings);
		if (shortcut !== undefined) return shortcut;
	}
	const navigation = pickerNavigationAction(key, filterEmpty, keybindings);
	if (navigation !== undefined) return navigation;
	return pickerFallbackAction(key, filterEmpty);
}

function pickerNavigationAction(
	key: string | undefined,
	filterEmpty: boolean,
	keybindings: KhalaConfig["keybindings"],
): PickerInputAction | undefined {
	if (key === keybindings.refresh) return "refresh";
	if (filterEmpty) {
		if (key === keybindings.history) return "history";
	}
	return PICKER_NAVIGATION_ACTIONS.get(key);
}

const PICKER_BACK_KEYS: ReadonlySet<string | undefined> = new Set(["escape", "ctrl+c"]);

function pickerFallbackAction(key: string | undefined, filterEmpty: boolean): PickerInputAction {
	if (PICKER_BACK_KEYS.has(key)) return "back";
	if (filterEmpty && key === "backspace") return "back";
	return "type";
}

function pickerShortcut(
	key: string | undefined,
	keybindings: KhalaConfig["keybindings"],
	showSettings: boolean,
): PickerInputAction | undefined {
	const shortcuts = [
		...(showSettings ? [[keybindings.roleSettings, "settings"] as const] : []),
		[keybindings.help, "help"],
		[keybindings.refresh, "refresh"],
		[keybindings.history, "history"],
	] as const;
	return shortcuts.find(([expected]) => expected === key)?.[1];
}

function nextPickerIndex(index: number, length: number, movingUp: boolean): number {
	if (movingUp) return index === 0 ? length - 1 : index - 1;
	return index === length - 1 ? 0 : index + 1;
}

function emptyPickerMessage(work: readonly WorkSummary[], showHistory: boolean | undefined): string {
	if (work.length > 0) return "  No matching Work";
	return showHistory === true
		? "  No Work has been submitted"
		: "  No active Work; press history to view completed Work";
}

function refreshedWorkIndex(selectedWorkId: string | undefined, work: readonly WorkSummary[], index: number): number {
	if (selectedWorkId !== undefined) {
		const refreshedIndex = work.findIndex((item) => item.workId === selectedWorkId);
		if (refreshedIndex >= 0) return refreshedIndex;
	}
	return Math.min(index, Math.max(0, work.length - 1));
}

function filterWork(work: readonly WorkSummary[], query: string): readonly WorkSummary[] {
	if (query.length === 0) return work;
	return fuzzyFilter(
		[...work],
		query,
		(item) => `${item.title} ${item.workId} ${item.state} ${item.executionState ?? ""}`,
	);
}

const NAVIGATION_FOOTER = "up/down move  enter select  escape/ctrl+c/backspace back";
const RECORD_NAVIGATION_FOOTER = "up/down move  enter inspect  escape/ctrl+c/backspace back";
const PANEL_BACK_FOOTER = "escape/ctrl+c/backspace back";

function workPickerKeybindings(
	keybindings: KhalaConfig["keybindings"],
	showHistory: boolean,
	showSettings: boolean,
): string {
	const settings = showSettings ? `  ${keybindings.roleSettings} settings when filter is empty` : "";
	return `type to filter  ${keybindings.refresh} refresh  ${keybindings.history} ${showHistory ? "active Work" : "history"} when filter is empty  home first  up/down move  enter open  ${keybindings.help} help when filter is empty${settings}  escape/ctrl+c/backspace back`;
}

function normalizeKeybindings(keybindings: KhalaConfig["keybindings"]): KhalaConfig["keybindings"] {
	return {
		roleSettings: configuredKeybinding(keybindings.roleSettings, "r"),
		comments: configuredKeybinding(keybindings.comments, "c"),
		refresh: configuredKeybinding(keybindings.refresh, "ctrl+r"),
		help: configuredKeybinding(keybindings.help, "?"),
		history: configuredKeybinding(keybindings.history, "h"),
	};
}

function configuredKeybinding(value: string, fallback: string): string {
	return value || fallback;
}

function pickerWork(work: readonly WorkSummary[], showHistory: boolean): readonly WorkSummary[] {
	return showHistory ? work : work.filter((item) => !isHiddenWork(item));
}

function workPickerHelp(keybindings: KhalaConfig["keybindings"], showSettings = true): readonly string[] {
	return [
		"Use the Work picker to inspect active or historical Work.",
		"",
		`${keybindings.refresh}  Refresh Work and preserve the current selection and filter.`,
		`${keybindings.history}  Toggle completed and cancelled Work when the filter is empty.`,
		`${keybindings.help}  Open this help when the filter is empty.`,
		...(showSettings ? [`${keybindings.roleSettings}  Open role settings when the filter is empty.`] : []),
		"Up/Down  Move selection; Home  select the first Work; Enter  open.",
		"Backspace  Clear a nonempty filter; otherwise go back. Escape or Ctrl-C  Close the picker.",
	];
}

function addPanelKeybindings(container: Container, theme: Theme, footer: string): Text {
	const keybindings = new Text(theme.fg("dim", footer), 1, 0);
	container.addChild(keybindings);
	container.addChild(new Spacer(1));
	return keybindings;
}

function recoveryDisplayRows(display: RecoveryDisplay): readonly (readonly [string, string])[] {
	const rows: Array<readonly [string, string]> = [
		["Status", display.status],
		["Progress", display.progress],
		["Doing", display.doing],
		["Next", display.next],
	];
	if (display.reason !== undefined) rows.splice(3, 0, ["Reason", display.reason]);
	if (display.evidence !== undefined && display.evidence.length > 0)
		rows.splice(4, 0, ["Evidence", display.evidence.join(", ")]);
	return rows;
}

function addHeading(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
}

function formatFieldRows(rows: readonly (readonly [string, string])[]): readonly string[] {
	if (rows.length === 0) return [];
	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
}

function addKeyValueRows(container: Container, theme: Theme, rows: readonly (readonly [string, string])[]): void {
	const lines = formatFieldRows(rows);
	if (lines.length === 0) return;
	container.addChild(new Text(theme.fg("muted", lines.join("\n")), 1, 0));
}

type WorkSection = "actions" | "evidence" | "peer-review" | "archive" | "blocking-signal";
async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
): Promise<"back"> {
	for (;;) {
		const work = await service.inspectRuntime(workId);
		const navigation = readArchiveRecordsForNavigation(service, work, actor);
		const section = await pickSection(work, navigation.records, navigation.error, context, keybindings);
		if (section === null || section === "back") return "back";
		await showWorkSection(section, service, context, work, actor, navigation.records);
	}
}

async function showArchiveWork(archive: KhalaArchiveView, context: ExtensionContext, workId: string): Promise<void> {
	const work = archive.inspectWork(workId);
	await showTextPage(context, truncateWorkName(work.terms.title), formatFieldRows(workSectionRows(work, undefined)));
}

async function showWorkSection(
	section: WorkSection,
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	records: readonly RecordView[],
): Promise<void> {
	const handlers = {
		actions: () => chooseAction(service, context, work, actor),
		evidence: () => showEvidence(service, work, context, actor),
		archive: () => showArchive(service, context, work, actor),
		"peer-review": () => showPeerReview(providerReviewComments(records), context),
		"blocking-signal": () => showBlockingSignal(work, context),
	} satisfies Record<WorkSection, () => Promise<void>>;
	await handlers[section]();
}

async function pickSection(
	work: WorkView,
	records: readonly RecordView[],
	archiveError: string | undefined,
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
): Promise<WorkSection | "back" | null> {
	const reviewComments = providerReviewComments(records);
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		...(reviewComments.length === 0 ? [] : [{ value: "peer-review", label: "Peer-Review" }]),
		{ value: "archive", label: "Archive" },
		...(hasCurrentBlockedSignal(work) ? [{ value: "blocking-signal", label: "Inspect blocking signal" }] : []),
	];
	return context.ui.custom<WorkSection | "back" | null>((tui, theme, _keybindings, done) => {
		const rows = workSectionRows(work, archiveError);
		const list = new SelectList(items, items.length, selectorTheme(theme));
		list.onSelect = (item) => done(isWorkSection(item.value) ? item.value : "back");
		list.onCancel = () => done("back");
		const container = new Container();
		addHeading(container, theme, truncateWorkName(work.terms.title));
		container.addChild(new Spacer(1));
		addKeyValueRows(container, theme, rows);
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		const footer =
			reviewComments.length === 0 ? NAVIGATION_FOOTER : `${NAVIGATION_FOOTER}  ${keybindings.comments} peer-review`;
		addPanelKeybindings(container, theme, footer);
		return selectableComponent(
			container,
			list,
			tui,
			() => done("back"),
			(data) => {
				if (reviewComments.length === 0 || parseKey(data) !== keybindings.comments) return false;
				done("peer-review");
				return true;
			},
		);
	});
}

function workSectionRows(work: WorkView, archiveError: string | undefined): readonly (readonly [string, string])[] {
	return [
		["Work", formatWorkState(work)],
		...missionRow(work),
		...archiveErrorRow(archiveError),
		...executionRows(work.execution),
		...reviewRequestRow(work),
		...workErrorRow(work),
		...nextActionRow(work),
	];
}

function missionRow(work: WorkView): readonly (readonly [string, string])[] {
	return work.state !== "stopped" && work.mission !== undefined && work.missionState !== undefined
		? [["Mission", formatMissionState(work.missionState)]]
		: [];
}

function archiveErrorRow(error: string | undefined): readonly (readonly [string, string])[] {
	return error === undefined ? [] : [["Archive", `unavailable: ${error}`]];
}

function executionRows(execution: WorkView["execution"]): readonly (readonly [string, string])[] {
	if (execution === undefined) return [];
	return [
		["Execution", formatExecutionState(execution)] as const,
		...(shouldShowRuntime(execution) ? [["Runtime", formatRuntimeState(execution)] as const] : []),
	];
}

function reviewRequestRow(work: WorkView): readonly (readonly [string, string])[] {
	const request = work.reviewRequest;
	return request === undefined ? [] : [[request.provider === "gitlab" ? "MR" : "PR", `#${request.providerId}`]];
}

function workErrorRow(work: WorkView): readonly (readonly [string, string])[] {
	return work.lastError === undefined
		? []
		: [["Attention", truncateToWidth(presentEvidenceText(work.lastError.summary), 120, "")]];
}

function nextActionRow(work: WorkView): readonly (readonly [string, string])[] {
	return work.nextAction.trim().length === 0 ? [] : [["Next", presentEvidenceText(work.nextAction)]];
}

function shouldShowRuntime(execution: NonNullable<WorkView["execution"]>): boolean {
	return execution.runtimeState !== undefined && !["completed", "failed", "stopped"].includes(execution.state);
}
async function selectAction(actions: readonly Action[], context: ExtensionContext): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		addHeading(container, theme, "Actions");
		container.addChild(new Spacer(1));
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
		return selectableComponent(container, list, tui, () => done("back"));
	});
}

async function applySelectedAction(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	action: Action,
): Promise<void> {
	if (action.kind === "recover") {
		await showRecovery(service, context, work, actor, action);
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
		`next: ${presentEvidenceText(result.value.nextAction)}`,
	]);
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
		await showTextPage(context, "Actions", ["No actions are currently available."]);
		return;
	}
	await runSelectedAction(actions, service, context, work, actor);
}

async function runSelectedAction(
	actions: readonly Action[],
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<void> {
	const selected = await selectAction(actions, context);
	if (selected === null || selected === "back") return;
	const action = actions.find((candidate) => candidate.id === selected);
	if (action === undefined) return;
	await applySelectedAction(service, context, work, actor, action);
}

function displayActionLabel(action: Action): string {
	const labels = {
		admit: "Admit",
		"request-input": "Request User input",
		"amend-terms": "Amend Work terms",
		"amend-mission": "Amend Mission",
		"launch-observer": "Launch observer",
		"record-assessment": "Record assessment",
		"start-execution": "Start execution",
		"record-signal": "Record signal",
		"commit-sandbox": "Commit sandbox changes",
		"run-validation": "Run validation",
		"create-review-request": "Create review request",
		"run-oracle": "Run oracle",
		verdict: "Record verdict",
		"deliver-feedback": "Deliver feedback",
		"record-review": "Record review",
		"record-outcome": "Record outcome",
		cancel: "Cancel",
		recover: "Recover",
		"rename-work": "Rename",
		"amend-budget": "Amend budget",
		"fail-work": "Fail",
	} satisfies Partial<Record<Action["kind"], string>>;
	return labels[action.kind] ?? action.label;
}

function schedulePendingEffects(service: ApplicationService): void {
	queueMicrotask(() => void service.processPendingEffects().catch(() => undefined));
}

type RecoveryDisplay = Readonly<{
	status: "in progress" | "succeeded" | "failed";
	progress: string;
	doing: string;
	next: string;
	reason?: string | undefined;
	evidence?: readonly string[] | undefined;
}>;
type RecoveryResult = Awaited<ReturnType<ApplicationService["perform"]>>;

function recoveryFailureDisplay(message: string): RecoveryDisplay {
	return {
		status: "failed",
		progress: "stopped",
		doing: "Khala could not restore the Executor",
		reason: message,
		next: "Return to Actions and retry after inspecting Evidence.",
	};
}

function recoveryResultDisplay(work: WorkView, result: RecoveryResult): RecoveryDisplay {
	if ("error" in result)
		return {
			status: "failed",
			progress: "stopped",
			doing: "Khala could not restore the Executor",
			reason: `${result.error.code}: ${presentEvidenceText(result.error.summary)}`,
			next: presentEvidenceText(result.error.remediation),
			evidence: result.error.evidenceRefs,
		};
	return recoverySuccessDisplay(work, result.value);
}

function recoverySuccessDisplay(work: WorkView, value: WorkView): RecoveryDisplay {
	if (recoveryFailed(value))
		return {
			status: "failed",
			progress: "stopped",
			doing: "Khala could not restore the Executor",
			reason: "The restored connection could not be confirmed",
			next: "Inspect Evidence and decide what to do next.",
		};
	const awaitingReview = value.execution?.state === "awaiting-review";
	return {
		status: "succeeded",
		progress: "complete",
		doing: recoveryCompletionDoing(work, awaitingReview),
		next: recoveryCompletionNext(work, awaitingReview),
	};
}

function recoveryFailed(value: WorkView): boolean {
	return (value.state === "stopped" && value.stopReason === "failed") || value.execution?.state === "failed";
}

function recoveryCompletionDoing(work: WorkView, awaitingReview: boolean): string {
	if (work.state === "stopped" && work.stopReason === "cancelled") return "Returned to admission";
	if (awaitingReview) return "Executor restored and waiting for review";
	return "Executor restored and ready to continue";
}

function recoveryCompletionNext(work: WorkView, awaitingReview: boolean): string {
	if (work.state === "stopped" && work.stopReason === "cancelled")
		return "No action is needed. Khala will continue automatically.";
	if (awaitingReview) return "Review the Work when the provider responds.";
	return "No action is needed. Khala will continue automatically.";
}

async function showRecovery(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	action: Action,
): Promise<void> {
	await context.ui.custom<void>((tui, theme, _keybindings, done) => {
		let closed = false;
		let display: RecoveryDisplay = {
			status: "in progress",
			progress: "checking runtime",
			doing:
				work.state === "stopped" && work.stopReason === "cancelled"
					? "Preparing a new attempt."
					: "Khala is checking and restoring the Executor.",
			next: "Keep this screen open until recovery finishes.",
		};
		const body = new Text("", 1, 0);
		const container = new Container();
		addHeading(container, theme, "Recovery");
		container.addChild(new Spacer(1));
		container.addChild(body);
		container.addChild(new Spacer(1));
		const footer = addPanelKeybindings(container, theme, "recovery is in progress");

		const renderDisplay = (): void => {
			body.setText(theme.fg("muted", formatFieldRows(recoveryDisplayRows(display)).join("\n")));
			footer.setText(theme.fg("dim", display.status === "in progress" ? "recovery is in progress" : PANEL_BACK_FOOTER));
			tui.requestRender();
		};
		const update = (next: RecoveryDisplay): void => {
			display = next;
			if (!closed) renderDisplay();
		};
		const onRecoveryUpdate = (progress: RecoveryUpdate): void => {
			update({
				status: "in progress",
				progress: `${formatStatus(progress.stage)}  ${presentEvidenceText(progress.message)}`,
				doing: "Khala is restoring the Executor",
				next: "Keep this screen open until recovery finishes.",
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
						actor,
						expectedWorkRevision: work.revision,
						schemaVersion: 1,
					},
					onRecoveryUpdate,
				})
				.then((result) => {
					if (!("error" in result)) schedulePendingEffects(service);
					update(recoveryResultDisplay(work, result));
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					update(recoveryFailureDisplay(message));
				});
		});
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (display.status === "in progress") return;
				if (isPanelBack(data)) {
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
const ROLE_TABLE_GAP = 2;
type RoleTableLayout = Readonly<{ role: number; model: number; thinking: number }>;
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
			get focused() {
				return selector.getSearchInput().focused;
			},
			set focused(value: boolean) {
				selector.getSearchInput().focused = value;
			},
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
type RoleSettingsSnapshot = Readonly<{ role: GovernedRole; current: RoleSettingsMap[GovernedRole] }>;

function roleFromSelection(value: string | undefined): GovernedRole | undefined {
	return ROLE_ORDER.find((role) => role === value);
}

function roleTableLayout(width: number, settings: RoleSettingsMap): RoleTableLayout {
	const available = Math.max(1, width - 2);
	const role = Math.max(...ROLE_ORDER.map((item) => ROLE_LABELS[item].length));
	const thinking = Math.max("THINKING".length, ...ROLE_ORDER.map((item) => settings[item].thinking.length));
	return { role, model: Math.max(1, available - role - thinking - ROLE_TABLE_GAP * 2), thinking };
}

function roleTableHeader(theme: Theme, layout: RoleTableLayout): string {
	return theme.fg(
		"dim",
		`  ${tableCell("ROLE", layout.role)}${" ".repeat(ROLE_TABLE_GAP)}${tableCell("MODEL", layout.model)}${" ".repeat(ROLE_TABLE_GAP)}${tableCell("THINKING", layout.thinking)}`,
	);
}

function roleTableRow(
	theme: Theme,
	settings: RoleSettingsMap,
	role: GovernedRole,
	selected: boolean,
	layout: RoleTableLayout,
): string {
	const current = settings[role];
	const row = `${tableCell(ROLE_LABELS[role], layout.role)}${" ".repeat(ROLE_TABLE_GAP)}${tableCell(current.model || "not configured", layout.model)}${" ".repeat(ROLE_TABLE_GAP)}${tableCell(current.thinking, layout.thinking)}`;
	const indented = `${selectionMarker(selected)}${row}`;
	return selected ? theme.fg("accent", theme.bold(indented)) : indented;
}

function roleTableComponent(
	theme: Theme,
	settings: RoleSettingsMap,
	selectedRole: () => GovernedRole | undefined,
): Component {
	return {
		render: (width: number) => {
			const layout = roleTableLayout(width, settings);
			return [
				roleTableHeader(theme, layout),
				...ROLE_ORDER.map((role) => roleTableRow(theme, settings, role, selectedRole() === role, layout)),
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate: () => {},
	};
}

async function selectRoleTable(
	context: ExtensionContext,
	settings: RoleSettingsMap,
): Promise<GovernedRole | undefined> {
	return context.ui.custom<GovernedRole | undefined>((tui, theme, _keybindings, done) => {
		const items: SelectItem[] = ROLE_ORDER.map((role) => ({ value: role, label: ROLE_LABELS[role] }));
		const list = new SelectList(items, items.length, selectorTheme(theme));
		list.onSelect = (item) => {
			const role = roleFromSelection(item.value);
			if (role !== undefined) done(role);
		};
		list.onCancel = () => done(undefined);
		list.onSelectionChange = () => tui.requestRender();
		const container = new Container();
		addHeading(container, theme, "Role settings");
		container.addChild(new Spacer(1));
		container.addChild(roleTableComponent(theme, settings, () => roleFromSelection(list.getSelectedItem()?.value)));
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, "up/down move  enter edit  escape/ctrl+c/backspace back");
		return selectableComponent(container, list, tui, () => done(undefined));
	});
}

async function editRoleSetting(
	controller: RoleSettingsController,
	context: ExtensionContext,
	snapshot: RoleSettingsSnapshot,
): Promise<void> {
	const { role, current } = snapshot;
	const selectedSetting = await selectRoleOption(context, `${ROLE_LABELS[role]} settings:`, [
		`Model: ${current.model || "not configured"}`,
		`Thinking: ${current.thinking}`,
	]);
	if (selectedSetting === undefined) return;
	const setting: RoleSetting = selectedSetting.startsWith("Model") ? "model" : "thinking";
	await saveSelectedRoleSetting(controller, context, role, current, setting);
}

async function saveSelectedRoleSetting(
	controller: RoleSettingsController,
	context: ExtensionContext,
	role: GovernedRole,
	current: RoleSettingsMap[GovernedRole],
	setting: RoleSetting,
): Promise<void> {
	const value = await roleSettingValue(context, role, current, setting);
	if (value === undefined) return;
	await saveRoleSetting(controller, context, role, setting, value);
}

async function roleSettingValue(
	context: ExtensionContext,
	role: GovernedRole,
	current: RoleSettingsMap[GovernedRole],
	setting: RoleSetting,
): Promise<string | undefined> {
	if (setting === "model") {
		const selectedModel = await selectRoleModel(context, current.model);
		return selectedModel === undefined ? undefined : `${selectedModel.provider}/${selectedModel.id}`;
	}
	return selectRoleThinking(context, role, current);
}

async function selectRoleThinking(
	context: ExtensionContext,
	role: GovernedRole,
	current: RoleSettingsMap[GovernedRole],
): Promise<string | undefined> {
	const separator = current.model.indexOf("/");
	const model =
		separator <= 0
			? undefined
			: context.modelRegistry.find(current.model.slice(0, separator), current.model.slice(separator + 1));
	const supportedThinking = model === undefined ? ["off"] : getSupportedThinkingLevels(model);
	const thinkingOptions = Array.from(new Set([current.thinking, ...supportedThinking]));
	return selectRoleOption(context, `${ROLE_LABELS[role]} thinking:`, thinkingOptions);
}

async function saveRoleSetting(
	controller: RoleSettingsController,
	context: ExtensionContext,
	role: GovernedRole,
	setting: RoleSetting,
	value: string,
): Promise<void> {
	try {
		await controller.set(role, setting, value);
		context.ui.notify(`${ROLE_LABELS[role]} ${setting} updated.`, "info");
	} catch (error) {
		context.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function showRoleSettings(controller: RoleSettingsController, context: ExtensionContext): Promise<void> {
	for (;;) {
		const settings = controller.get();
		const role = await selectRoleTable(context, settings);
		if (role === undefined) return;
		await editRoleSetting(controller, context, { role, current: settings[role] });
	}
}

function selectorTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => theme.fg("accent", theme.bold(text)),
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
const WORK_SECTIONS: readonly WorkSection[] = ["actions", "evidence", "archive", "peer-review", "blocking-signal"];

function isWorkSection(value: string): value is WorkSection {
	return WORK_SECTIONS.some((section) => section === value);
}

function formatStatus(value: string): string {
	return value.replace(/-/g, " ");
}

function formatWorkState(work: WorkView): string {
	const state =
		work.state === "stopped" && work.stopReason !== undefined
			? `stopped (${formatStatus(work.stopReason)})`
			: formatStatus(work.state);
	return work.lastError === undefined ? state : `${state} (attention)`;
}

function formatMissionState(value: string): string {
	return value === "active" ? "in progress" : formatStatus(value);
}

function formatExecutionState(execution: WorkView["execution"]): string {
	if (execution === undefined) return "not started";
	return execution.state === "running" ? "running" : formatStatus(execution.state);
}
function formatRuntimeState(execution: WorkView["execution"]): string {
	if (execution === undefined) return "unavailable";
	const runtime = execution.runtimeState ?? "unknown";
	return execution.state === "blocked" ? blockedRuntimeLabel(runtime) : formatStatus(runtime);
}

const BLOCKED_RUNTIME_LABELS = new Map<string, string>([
	["working", "finishing current turn"],
	["pending", "awaiting Conclave"],
	["idle", "idle (awaiting Conclave)"],
	["unreachable", "unreachable (awaiting Conclave)"],
]);

function blockedRuntimeLabel(runtime: string): string {
	return BLOCKED_RUNTIME_LABELS.get(runtime) ?? "unknown (awaiting Conclave)";
}

type PageSection = Readonly<{ heading?: string; lines: readonly string[] }>;
type RecordPage = Readonly<{ title: string; sections: readonly PageSection[] }>;

function pageSection(lines: readonly string[], heading?: string): PageSection {
	return heading === undefined ? { lines } : { heading, lines };
}

function optionalPageSection(lines: readonly string[], heading?: string): readonly PageSection[] {
	return lines.length === 0 ? [] : [pageSection(lines, heading)];
}

type RecordListMode = "evidence" | "archive";
type NavigationRecords = Readonly<{ records: readonly RecordView[]; error?: string }>;
type RecordListEntry = Readonly<{ kind: "record"; record: RecordView }>;
type MutableJsonObject = { [key: string]: JsonValue | undefined };
type MutableProviderReviewComment = {
	id: string;
	body: string;
	author?: string;
	authorAssociation?: string;
	createdAt?: string;
	url?: string;
	state?: string;
	source?: ProviderReviewComment["source"];
	location?: string;
	minimized?: boolean;
};
type ProviderReviewCommentExtras = Omit<MutableProviderReviewComment, "id" | "body">;

function providerReviewComments(records: readonly RecordView[]): readonly ProviderReviewComment[] {
	for (const record of [...records].reverse()) {
		const comments = providerReviewCommentsFromRecord(record);
		if (comments !== undefined) return comments;
	}
	return [];
}

function providerReviewCommentsFromRecord(record: RecordView): readonly ProviderReviewComment[] | undefined {
	if (record.kind !== "observation") return undefined;
	const payload =
		readPayloadObject(readPayloadObjectValue(record.payload), "details") ??
		readPayloadObject(readPayloadObjectValue(record.payload), "providerObservation");
	return readProviderReviewComments(payload?.["comments"]);
}

function readProviderReviewComments(value: JsonValue | undefined): readonly ProviderReviewComment[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const comments = value
		.filter(isJsonObject)
		.map(readProviderReviewComment)
		.filter((comment): comment is ProviderReviewComment => comment !== undefined)
		.filter((comment) => comment.body.trim().length > 0);
	return comments.filter((comment, index, all) => all.findIndex((candidate) => candidate.id === comment.id) === index);
}

function readProviderReviewComment(value: JsonObject): ProviderReviewComment | undefined {
	const identity = providerReviewCommentIdentity(value);
	return identity === undefined ? undefined : { ...identity, ...providerReviewCommentExtras(value) };
}

function providerReviewCommentIdentity(value: JsonObject): Readonly<{ id: string; body: string }> | undefined {
	const id = readObjectText(value, "id");
	const body = readObjectText(value, "body");
	return id === undefined || body === undefined ? undefined : { id, body };
}

function providerReviewCommentExtras(value: JsonObject): ProviderReviewCommentExtras {
	const extras: ProviderReviewCommentExtras = {};
	addCommentAuthorFields(extras, value);
	addCommentSourceFields(extras, value);
	addCommentReviewFields(extras, value);
	addCommentPresentationFields(extras, value);
	return extras;
}

function addCommentAuthorFields(extras: ProviderReviewCommentExtras, value: JsonObject): void {
	const author = readObjectText(value, "author");
	const authorAssociation = readObjectText(value, "authorAssociation");
	if (author !== undefined) extras.author = author;
	if (authorAssociation !== undefined) extras.authorAssociation = authorAssociation;
}

function addCommentSourceFields(extras: ProviderReviewCommentExtras, value: JsonObject): void {
	const createdAt = readObjectText(value, "createdAt");
	const url = readObjectText(value, "url");
	if (createdAt !== undefined) extras.createdAt = createdAt;
	if (url !== undefined) extras.url = url;
}

function addCommentReviewFields(extras: ProviderReviewCommentExtras, value: JsonObject): void {
	const state = readObjectText(value, "state");
	const source = readCommentSource(value);
	if (state !== undefined) extras.state = state;
	if (source !== undefined) extras.source = source;
}

function addCommentPresentationFields(extras: ProviderReviewCommentExtras, value: JsonObject): void {
	const location = readObjectText(value, "location");
	const minimized = readObjectBoolean(value, "minimized");
	if (location !== undefined) extras.location = location;
	if (minimized !== undefined) extras.minimized = minimized;
}

function readCommentSource(value: JsonObject): ProviderReviewComment["source"] {
	const source = readObjectText(value, "source");
	return source === "issue-comment" || source === "review" || source === "inline" ? source : undefined;
}

function readObjectBoolean(object: JsonObject | undefined, key: string): boolean | undefined {
	const value = object?.[key];
	return value === true || value === false ? value : undefined;
}
function hasCurrentBlockedSignal(work: WorkView): boolean {
	return work.execution?.state === "blocked" && isCurrentBlockedSignal(work.lastSignal, work.execution?.executionId);
}

function isCurrentBlockedSignal(signal: Signal | undefined, executionId: string | undefined): boolean {
	return signal?.kind === "blocked" && signal.executionId === executionId;
}

const EVIDENCE_RECORD_KINDS: readonly RecordKind[] = [
	"assessment",
	"learning",
	"validation",
	"signal",
	"review-request",
	"observation",
	"delivery",
	"verdict",
	"oracle-review",
	"outcome",
	"error",
];
type EvidenceSelectionContext = Readonly<{
	missionId: string | undefined;
	executionId: string | undefined;
	reviewProviderId: string | undefined;
	reviewUrl: string | undefined;
	retainsLastError: boolean;
}>;

function evidenceSelectionContext(work: WorkView): EvidenceSelectionContext {
	const { missionId } = work.mission ?? {};
	const { executionId } = work.execution ?? {};
	const { providerId: reviewProviderId, url: reviewUrl } = work.reviewRequest ?? {};
	return { missionId, executionId, reviewProviderId, reviewUrl, retainsLastError: Boolean(work.lastError) };
}

function matchesExecution(record: RecordView, executionId: string | undefined): boolean {
	return executionId !== undefined && record.executionId === executionId;
}

function matchesMission(record: RecordView, missionId: string | undefined): boolean {
	return missionId !== undefined && record.missionId === missionId;
}

function recordMatchesBinding(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return matchesExecution(record, selection.executionId) || matchesMission(record, selection.missionId);
}

function isChangedObservationRecord(record: RecordView): boolean {
	return record.kind === "observation" && readPayloadBoolean(record.payload, "changed") === true;
}

function shouldIncludePrimaryEvidence(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		EVIDENCE_RECORD_KINDS.includes(record.kind) &&
		(recordMatchesBinding(record, selection) || isChangedObservationRecord(record) || record.evidenceRefs.length > 0)
	);
}

function addEvidenceRecord(selected: Map<number, RecordView>, record: RecordView | undefined): void {
	if (record !== undefined) selected.set(record.sequence, record);
}

function latestRecord(
	records: readonly RecordView[],
	predicate: (record: RecordView) => boolean,
): RecordView | undefined {
	return [...records].reverse().find(predicate);
}

function isRelevantErrorRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "error" && (recordMatchesBinding(record, selection) || selection.retainsLastError);
}

function signalScopeMatches(record: RecordView, selection: EvidenceSelectionContext): boolean {
	if (selection.executionId === undefined) return true;
	return recordMatchesBinding(record, selection) || matchesExecution(record, selection.executionId);
}

function isRelevantSignalRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "signal" && signalScopeMatches(record, selection);
}

function reviewRequestMatchesScope(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		(selection.reviewProviderId !== undefined &&
			readPayloadText(record.payload, "providerId") === selection.reviewProviderId) ||
		(selection.reviewUrl !== undefined && record.evidenceRefs.includes(selection.reviewUrl))
	);
}

function isRelevantReviewRequestRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "review-request" && reviewRequestMatchesScope(record, selection);
}

function isSupplementalEvidenceRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		isChangedObservationRecord(record) ||
		(["delivery", "verdict", "oracle-review", "outcome"].includes(record.kind) &&
			recordMatchesBinding(record, selection))
	);
}

function addPrimaryEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	for (const record of records) {
		if (shouldIncludePrimaryEvidence(record, selection)) addEvidenceRecord(selected, record);
	}
}

function addLatestEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantErrorRecord(record, selection)),
	);
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantSignalRecord(record, selection)),
	);
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantReviewRequestRecord(record, selection)),
	);
}

function addSupplementalEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	for (const record of records) {
		if (isSupplementalEvidenceRecord(record, selection)) addEvidenceRecord(selected, record);
	}
}

function addEvidenceFallback(selected: Map<number, RecordView>, records: readonly RecordView[]): void {
	if (selected.size === 0)
		addEvidenceRecord(
			selected,
			latestRecord(records, (record) => record.evidenceRefs.length > 0),
		);
}

function selectRelevantEvidence(work: WorkView, records: readonly RecordView[]): readonly RecordView[] {
	const selected = new Map<number, RecordView>();
	const selection = evidenceSelectionContext(work);
	addPrimaryEvidence(selected, records, selection);
	addLatestEvidence(selected, records, selection);
	addSupplementalEvidence(selected, records, selection);
	addEvidenceFallback(selected, records);
	return [...selected.values()].sort((left, right) => left.sequence - right.sequence);
}

async function showSelectedRecord(
	records: readonly RecordView[],
	selected: string,
	context: ExtensionContext,
): Promise<void> {
	const record = records.find((candidate) => String(candidate.sequence) === selected);
	if (record === undefined) return;
	const page = formatRecordPage(record);
	await showPage(context, page.title, page.sections);
}

async function browseRecordPages(
	records: readonly RecordView[],
	context: ExtensionContext,
	mode: RecordListMode,
	supplement: readonly PageSection[] = [],
): Promise<void> {
	for (;;) {
		const selected = await selectRecordPanel(records, context, mode, supplement);
		if (selected === null) return;
		await showSelectedRecord(records, selected, context);
	}
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
	await browseRecordPages(selectRelevantEvidence(work, records), context, "evidence", formatEvidenceSupplement(work));
}

function formatEvidenceSupplement(work: WorkView): readonly PageSection[] {
	const next = presentEvidenceText(work.nextAction);
	return next.length === 0 ? [] : [pageSection([next], "Next")];
}
async function browseReviewComments(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<void> {
	for (;;) {
		const selected = await selectReviewComment(comments, context);
		if (selected === null) return;
		const comment = comments[Number(selected)];
		if (comment === undefined) return;
		await showPage(context, "Peer-Review comment", formatReviewCommentSections(comment));
	}
}

async function showPeerReview(comments: readonly ProviderReviewComment[], context: ExtensionContext): Promise<void> {
	if (comments.length === 0) return;
	await browseReviewComments(comments, context);
}

async function selectReviewComment(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const list = new SelectList(
			comments.map((comment, index) => ({
				value: String(index),
				label: `${comment.author ?? "unknown author"} ${compactRecordSummary(comment.body)}`.trim(),
			})),
			Math.min(6, comments.length),
			selectorTheme(theme),
		);
		const container = new Container();
		addHeading(container, theme, "Peer-Review");
		container.addChild(new Text(theme.fg("muted", `${comments.length} comments`), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		return selectableComponent(container, list, tui, () => done(null));
	});
}
function appendCommentDetail<T>(details: string[], value: T | undefined, format: (value: T) => string): void {
	if (value !== undefined) details.push(format(value));
}

function formatCommentAuthor(author: string, association: string | undefined): string {
	return `author: ${author}${association === undefined ? "" : ` (${association})`}`;
}

function reviewCommentDetails(comment: ProviderReviewComment): readonly string[] {
	const details: string[] = [];
	appendCommentDetail(details, comment.author, (author) => formatCommentAuthor(author, comment.authorAssociation));
	appendCommentDetail(details, comment.createdAt, (createdAt) => `created: ${formatRecordedAt(createdAt)}`);
	appendCommentDetail(details, comment.source, (source) => `source: ${source}`);
	appendCommentDetail(details, comment.location, (location) => `location: ${location}`);
	appendCommentDetail(details, comment.state, (state) => `state: ${state}`);
	appendCommentDetail(details, comment.minimized, (minimized) => `minimized: ${minimized ? "yes" : "no"}`);
	return details;
}

function formatReviewCommentSections(comment: ProviderReviewComment): readonly PageSection[] {
	const details = reviewCommentDetails(comment);
	const source = comment.url === undefined ? [] : [pageSection([`url: ${comment.url}`], "Source")];
	return [...optionalPageSection(details), pageSection([comment.body], "Comment"), ...source];
}

async function showBlockingSignal(work: WorkView, context: ExtensionContext): Promise<void> {
	if (!hasCurrentBlockedSignal(work)) return;
	const signal = work.lastSignal;
	if (signal === undefined) return;
	await showPage(context, "Blocked", formatSignalSections(signal));
}

function formatSignalSections(signal: Signal): readonly PageSection[] {
	return [
		pageSection(formatFieldRows([["Observed", formatRecordedAt(signal.observedAt)]])),
		...formatExecutorEvidenceSections(signal.summary, signal.evidence),
	];
}

function formatExecutorEvidenceSections(response: string, evidence: readonly string[]): readonly PageSection[] {
	return [
		...(response.trim().length === 0 ? [] : [pageSection([response], "Executor response")]),
		...(evidence.length === 0 ? [] : [pageSection(evidence, "Evidence")]),
	];
}
async function selectRecordPanel(
	records: readonly RecordView[],
	context: ExtensionContext,
	mode: RecordListMode,
	supplement: readonly PageSection[] = [],
): Promise<string | null> {
	const entries: readonly RecordListEntry[] = records.map((record) => ({ kind: "record" as const, record }));
	const title = recordPanelTitle(mode, records.length);
	if (entries.length === 0) {
		await showPage(context, title, [
			pageSection([
				mode === "evidence" ? "No relevant evidence records are available." : "No Archive records are available.",
			]),
			...supplement,
		]);
		return null;
	}
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const list = createRecordList(entries, mode, theme, () => selectedIndex);
		const container = new Container();
		addHeading(container, theme, title);
		container.addChild(new Spacer(1));
		container.addChild(list);
		if (supplement.length > 0) container.addChild(new Spacer(1));
		addPageSections(container, theme, supplement);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, RECORD_NAVIGATION_FOOTER);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) =>
				handleRecordPanelInput(
					data,
					entries,
					() => selectedIndex,
					(value) => {
						selectedIndex = value;
					},
					tui.requestRender.bind(tui),
					done,
				),
		};
	});
}

type RecordPanelAction = "up" | "down" | "enter" | "back";
const RECORD_PANEL_ACTIONS: ReadonlyMap<string, RecordPanelAction> = new Map([
	["up", "up"],
	["down", "down"],
	["enter", "enter"],
	["escape", "back"],
	["ctrl+c", "back"],
	["backspace", "back"],
]);

function recordPanelAction(data: string): RecordPanelAction | undefined {
	return RECORD_PANEL_ACTIONS.get(parseKey(data) ?? "");
}

function moveRecordPanelSelection(
	action: "up" | "down",
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	setSelectedIndex: (index: number) => void,
	requestRender: () => void,
): void {
	setSelectedIndex(nextRecordIndex(getSelectedIndex(), entries.length, action === "up"));
	requestRender();
}

function selectRecordPanelEntry(
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	done: (value: string | null) => void,
): void {
	const entry = entries[getSelectedIndex()];
	if (entry?.kind === "record") done(String(entry.record.sequence));
}

function handleRecordPanelInput(
	data: string,
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	setSelectedIndex: (index: number) => void,
	requestRender: () => void,
	done: (value: string | null) => void,
): void {
	const action = recordPanelAction(data);
	if (action === undefined) return;
	const handlers = new Map<RecordPanelAction, () => void>([
		["up", () => moveRecordPanelSelection("up", entries, getSelectedIndex, setSelectedIndex, requestRender)],
		["down", () => moveRecordPanelSelection("down", entries, getSelectedIndex, setSelectedIndex, requestRender)],
		["enter", () => selectRecordPanelEntry(entries, getSelectedIndex, done)],
		["back", () => done(null)],
	]);
	handlers.get(action)?.();
}

function recordPanelTitle(mode: RecordListMode, count: number): string {
	return mode === "evidence" ? "Evidence" : `Archive ${count} ${count === 1 ? "record" : "records"}`;
}

function nextRecordIndex(index: number, length: number, movingUp: boolean): number {
	return movingUp ? (index === 0 ? length - 1 : index - 1) : index === length - 1 ? 0 : index + 1;
}

function createRecordList(
	entries: readonly RecordListEntry[],
	mode: RecordListMode,
	theme: Theme,
	getSelectedIndex: () => number,
): Component {
	return {
		render: (width: number) => {
			const selectedIndex = getSelectedIndex();
			const maxVisible = 6;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), entries.length - maxVisible));
			const visibleEntries = entries.slice(start, start + maxVisible);
			const lines = [recordListHeader(mode, width)];
			for (const [offset, entry] of visibleEntries.entries()) {
				lines.push(...recordListEntryLines(entry, mode, width, start + offset === selectedIndex, theme));
			}
			if (start > 0 || start + visibleEntries.length < entries.length) {
				lines.push(theme.fg("dim", `  ${selectedIndex + 1} of ${entries.length}`));
			}
			return lines.map((line) => truncateToWidth(line, width, ""));
		},
		invalidate: () => {},
	};
}

type RecordListLayout = Readonly<{ kind: number; actor: number; time: number; showContext: boolean }>;

function recordListLayout(mode: RecordListMode, width: number): RecordListLayout {
	const available = Math.max(1, width - 2);
	if (mode === "evidence" && width >= 96) {
		return {
			kind: RECORD_LIST_COLUMNS.kind,
			actor: RECORD_LIST_COLUMNS.actor,
			time: RECORD_LIST_COLUMNS.time,
			showContext: true,
		};
	}
	return {
		kind: Math.max(10, Math.min(RECORD_LIST_COLUMNS.kind, Math.floor(available * 0.3))),
		actor: 0,
		time: 0,
		showContext: false,
	};
}

function recordListHeader(mode: RecordListMode, width: number): string {
	const layout = recordListLayout(mode, width);
	const sequence = tableCell("SEQ", RECORD_LIST_COLUMNS.sequence);
	const kind = tableCell("KIND", layout.kind);
	if (!layout.showContext) return `  ${sequence}${kind}SUMMARY`;
	return `  ${sequence}${kind}${tableCell("ACTOR", layout.actor)}${tableCell("TIME", layout.time)}SUMMARY`;
}

function recordListEntryLines(
	entry: RecordListEntry,
	mode: RecordListMode,
	width: number,
	selected: boolean,
	theme: Theme,
): readonly string[] {
	const record = entry.record;
	const summary = compactRecordSummary(record.summary);
	const lines =
		mode === "evidence"
			? formatEvidenceRecordLines(record, summary, width)
			: formatArchiveRecordLines(record, summary, width);
	return markRecordListEntry(lines, selected, theme);
}

function markRecordListEntry(lines: readonly string[], selected: boolean, theme: Theme): readonly string[] {
	const marked = lines.map((line, index) => (index === 0 ? `${selectionMarker(selected)}${line.slice(2)}` : line));
	return selected ? marked.map((line) => theme.fg("accent", theme.bold(line))) : marked;
}

function compactRecordSummary(summary: string): string {
	const firstLine = summary.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
	return truncateToWidth(firstLine.replace(/\s+/g, " ").trim(), MAX_RECORD_LIST_SUMMARY_LENGTH, "");
}

function formatEvidenceRecordLines(record: RecordView, summary: string, width: number): readonly string[] {
	const layout = recordListLayout("evidence", width);
	let prefix = `  ${tableCell(String(record.sequence), RECORD_LIST_COLUMNS.sequence)}${tableCell(recordKindLabel(record), layout.kind)}`;
	if (layout.showContext) {
		prefix += `${tableCell(record.actor, layout.actor)}${tableCell(formatRecordedAt(record.recordedAt), layout.time)}`;
	}
	return summary.trim().length === 0 ? [prefix.trimEnd()] : wrapPrefixed(summary, prefix, visibleWidth(prefix), width);
}

function formatArchiveRecordLines(record: RecordView, summary: string, width: number): readonly string[] {
	const layout = recordListLayout("archive", width);
	const prefix = `  ${tableCell(String(record.sequence), RECORD_LIST_COLUMNS.sequence)}${tableCell(recordKindLabel(record), layout.kind)}`;
	return summary.trim().length === 0 ? [prefix.trimEnd()] : wrapPrefixed(summary, prefix, visibleWidth(prefix), width);
}

function wrapPrefixed(value: string, prefix: string, prefixWidth: number, width: number): readonly string[] {
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(value.length === 0 ? " " : value, available);
	return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}
function appendRecordMetadata(
	metadata: Array<readonly [string, string]>,
	label: string,
	value: string | number | undefined,
): void {
	if (value !== undefined) metadata.push([label, String(value)]);
}

function recordMetadata(record: RecordView): readonly (readonly [string, string])[] {
	const metadata: Array<readonly [string, string]> = [
		["Recorded", formatRecordedAt(record.recordedAt)],
		["Actor", record.actor],
		["Record number", String(record.recordNumber)],
	];
	appendRecordMetadata(metadata, "Mission record number", record.missionRecordNumber);
	metadata.push(["Record ID", record.id], ["Work ID", record.workId]);
	appendRecordMetadata(metadata, "Mission ID", record.missionId);
	appendRecordMetadata(metadata, "Execution ID", record.executionId);
	metadata.push(["Payload version", String(record.payloadVersion)]);
	return metadata;
}

function recordEvidenceReferences(fields: RecordDetailFields, evidenceRefs: readonly string[]): readonly string[] {
	if (fields.displayedEvidence === undefined) return evidenceRefs;
	return sameStringList(fields.displayedEvidence, evidenceRefs) ? [] : evidenceRefs;
}

function recordPageSections(
	metadata: readonly (readonly [string, string])[],
	payloadFields: RecordDetailFields,
	structuredFields: readonly string[],
	evidenceReferences: readonly string[],
): readonly PageSection[] {
	return [
		pageSection(formatFieldRows(metadata)),
		...payloadFields.sections,
		...optionalPageSection(structuredFields, "Structured fields"),
		...optionalPageSection(evidenceReferences, "Evidence references"),
	];
}

function formatRecordPage(record: RecordView): RecordPage {
	const payloadFields = recordDetailPayloadFields(record);
	const structuredFields = formatStructuredFields(record.payload, payloadFields.displayed);
	return {
		title: recordTitle(record),
		sections: recordPageSections(
			recordMetadata(record),
			payloadFields,
			structuredFields,
			recordEvidenceReferences(payloadFields, record.evidenceRefs),
		),
	};
}

type RecordDetailFields = Readonly<{
	sections: readonly PageSection[];
	displayed: readonly string[];
	displayedEvidence?: readonly string[] | undefined;
}>;

function recordTitle(record: RecordView): string {
	const kind = recordKindLabel(record);
	return record.kind === "signal"
		? kind === "signal"
			? `Signal ${record.sequence}`
			: `${capitalize(kind)} signal ${record.sequence}`
		: `${capitalize(kind)} ${record.sequence}`;
}
function signalSummarySection(record: RecordView, response: string | undefined): readonly PageSection[] {
	return record.summary.trim().length === 0 || response === record.summary
		? []
		: [pageSection([record.summary], "Summary")];
}

function signalResponseSection(record: RecordView, response: string | undefined): readonly PageSection[] {
	if (response !== undefined) return [pageSection([response], "Executor response")];
	return record.summary.trim().length === 0 ? [] : [pageSection([record.summary], "Executor response")];
}

function signalRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const response = readObjectText(payload, "summary");
	const evidence = readObjectTextList(payload, "evidence") ?? record.evidenceRefs;
	return {
		sections: [
			...signalSummarySection(record, response),
			...signalResponseSection(record, response),
			...optionalPageSection(evidence, "Evidence"),
		],
		displayed: ["kind", "summary", "evidence"],
		displayedEvidence: evidence,
	};
}

function errorFailureSection(record: RecordView, failure: string | undefined): readonly PageSection[] {
	if (failure === undefined) return [];
	if (failure.trim() === record.summary.trim()) return [];
	return [pageSection([failure], "Failure")];
}

function errorRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const learning = readPayloadObject(payload, "learning");
	const failure = readObjectText(learning, "failure");
	const remediation = readObjectText(payload, "remediation");
	return {
		sections: [
			...formatRecordSummarySections(record, payload, "Error"),
			...optionalPageSection(remediation === undefined ? [] : [remediation], "Recovery"),
			...errorFailureSection(record, failure),
		],
		displayed: ["summary", "remediation", "learning", "evidenceRefs"],
	};
}

function genericRecordDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	return {
		sections: formatRecordSummarySections(record, payload),
		displayed: ["summary"],
	};
}

function recordDetailPayloadFields(record: RecordView): RecordDetailFields {
	const payload = readPayloadObjectValue(record.payload);
	if (record.kind === "signal") return signalRecordDetailFields(record, payload);
	if (record.kind === "error") return errorRecordDetailFields(record, payload);
	if (record.kind === "oracle-review") return formatOracleDetailFields(record, payload);
	return genericRecordDetailFields(record, payload);
}
function formatRecordSummarySections(
	record: RecordView,
	payload: JsonObject | undefined,
	payloadHeading = "Payload summary",
): readonly PageSection[] {
	return [
		...(record.summary.trim().length === 0 ? [] : [pageSection([record.summary], "Summary")]),
		...payloadSummarySection(record, payload, payloadHeading),
	];
}

function payloadSummarySection(
	record: RecordView,
	payload: JsonObject | undefined,
	heading: string,
): readonly PageSection[] {
	const summary = readObjectText(payload, "summary");
	return summary === undefined || summary.trim() === record.summary.trim() ? [] : [pageSection([summary], heading)];
}
function oracleVerdictSection(verdict: string | undefined): readonly PageSection[] {
	return verdict === undefined ? [] : [pageSection(formatFieldRows([["Verdict", verdict]]))];
}

function oracleFindingsSection(findings: readonly JsonObject[]): readonly PageSection[] {
	return findings.length === 0 ? [] : [pageSection(formatFindings(findings), "Findings")];
}

function oracleValidationSection(gaps: readonly string[]): readonly PageSection[] {
	return gaps.length === 0
		? []
		: [
				pageSection(
					gaps.map((gap, index) => `${index + 1}  ${gap}`),
					"Validation gaps",
				),
			];
}

function oracleOutputSection(output: string | undefined): readonly PageSection[] {
	return output === undefined ? [] : [pageSection([output], "Model response")];
}

function oracleDurationSection(duration: number | undefined): readonly PageSection[] {
	return duration === undefined ? [] : [pageSection(formatFieldRows([["Duration", `${duration} ms`]]))];
}

function formatOracleDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const findings = readPayloadObjects(payload, "findings");
	const gaps = readObjectTextList(payload, "validationGaps") ?? [];
	const output = readObjectText(payload, "output");
	const duration = readObjectNumber(payload, "durationMs");
	const verdict = readObjectText(payload, "verdict");
	return {
		sections: [
			...formatRecordSummarySections(record, payload),
			...oracleVerdictSection(verdict),
			...oracleFindingsSection(findings),
			...oracleValidationSection(gaps),
			...oracleOutputSection(output),
			...oracleDurationSection(duration),
		],
		displayed: ["summary", "verdict", "findings", "validationGaps", "output", "durationMs"],
	};
}

function formatFindings(findings: readonly JsonObject[]): readonly string[] {
	return findings.flatMap((finding, index) => {
		const severity = readObjectText(finding, "severity");
		const summary = readObjectText(finding, "summary");
		const evidence = readObjectTextList(finding, "evidence") ?? [];
		return [
			`${index + 1}${severity === undefined ? "" : `  ${severity}`}${summary === undefined ? "" : `  ${summary}`}`,
			...evidence.map((item) => `    ${item}`),
		];
	});
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatStructuredFields(payload: JsonValue, displayed: readonly string[]): readonly string[] {
	const remaining = omitPayloadFields(payload, displayed);
	if (remaining === undefined) return [];
	const serialized = JSON.stringify(remaining, null, 2);
	return serialized === "{}" || serialized === "[]" ? [] : serialized.split("\n");
}
function remainingPayloadFields(payload: JsonObject, excluded: ReadonlySet<string>) {
	const remaining: MutableJsonObject = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value !== undefined && !excluded.has(key)) remaining[key] = value;
	}
	return remaining;
}

function omitPayloadFields(payload: JsonValue, displayed: readonly string[]): JsonValue | undefined {
	if (!isJsonObject(payload)) return payload;
	const remaining = remainingPayloadFields(payload, new Set(displayed));
	return Object.keys(remaining).length === 0 ? undefined : remaining;
}
function recordKindLabel(record: RecordView): string {
	const signalKind = record.kind === "signal" ? readPayloadText(record.payload, "kind") : undefined;
	if (signalKind !== undefined && SIGNAL_KINDS.some((kind) => kind === signalKind)) return signalKind;
	const labels = {
		submission: "submission",
		assessment: "assessment",
		learning: "learning",
		mission: "mission",
		"mission-change": "mission change",
		execution: "execution",
		validation: "validation",
		signal: "signal",
		"review-request": "review request",
		observation: "observation",
		delivery: "delivery",
		verdict: "verdict",
		"oracle-review": "oracle review",
		outcome: "outcome",
		error: "error",
		"work-amended": "work amended",
	} satisfies Record<RecordKind, string>;
	return labels[record.kind];
}

const SIGNAL_KINDS: readonly string[] = ["ready", "progress", "blocked"];

function capitalize(value: string): string {
	return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function readPayloadObjectValue(payload: JsonValue): JsonObject | undefined {
	return isJsonObject(payload) ? payload : undefined;
}

function readPayloadObject(payload: JsonObject | undefined, key: string): JsonObject | undefined {
	const value = payload?.[key];
	return isJsonObject(value) ? value : undefined;
}

function readObjectText(object: JsonObject | undefined, key: string): string | undefined {
	const value = object?.[key];
	return isTextValue(value) ? value : undefined;
}

function readObjectTextList(object: JsonObject | undefined, key: string): readonly string[] | undefined {
	const value = object?.[key];
	return Array.isArray(value) && value.every(isTextValue) ? value : undefined;
}

function readPayloadObjects(object: JsonObject | undefined, key: string): readonly JsonObject[] {
	const value = object?.[key];
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}
function readObjectNumber(object: JsonObject | undefined, key: string): number | undefined {
	return finiteNumber(object?.[key]);
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
	const number = Number(value);
	return value !== undefined && value === number && Number.isFinite(number) ? number : undefined;
}

function readPayloadText(payload: JsonValue, key: string): string | undefined {
	return readObjectText(readPayloadObjectValue(payload), key);
}

function readPayloadBoolean(payload: JsonValue, key: string): boolean | undefined {
	return readObjectBoolean(readPayloadObjectValue(payload), key);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

function formatRecordedAt(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace("T", " ");
}
function errorMetadata(error: ErrorEnvelope): readonly (readonly [string, string])[] {
	const metadata: Array<readonly [string, string]> = [
		["code", error.code],
		["retryable", error.retryable ? "yes" : "no"],
	];
	if (error.evidenceRefs.length > 0) metadata.push(["evidence", error.evidenceRefs.join(", ")]);
	return metadata;
}

function nonBlankErrorLine(value: string): readonly string[] {
	return value.trim().length === 0 ? [] : [presentEvidenceText(value)];
}

function learningErrorLine(error: ErrorEnvelope): readonly string[] {
	const specificity = error.learning?.missionSpecificity;
	return specificity === undefined ? [] : [`learning: ${presentEvidenceText(specificity)}`];
}

function errorNextStep(error: ErrorEnvelope): readonly string[] {
	return [...nonBlankErrorLine(error.remediation), ...learningErrorLine(error)];
}

function formatErrorSections(error: ErrorEnvelope | undefined): readonly PageSection[] {
	if (error === undefined) return [];
	return [
		...optionalPageSection(nonBlankErrorLine(error.summary), "Error"),
		pageSection(formatFieldRows(errorMetadata(error))),
		...optionalPageSection(errorNextStep(error), "Next step"),
	];
}

function presentEvidenceText(value: string): string {
	return value.trim();
}

function readArchiveRecordsForNavigation(service: ApplicationService, work: WorkView, actor: Actor): NavigationRecords {
	try {
		return { records: readAllArchiveRecords(service, work, actor) };
	} catch (error) {
		return { records: [], error: error instanceof Error ? error.message : String(error) };
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
	await browseRecordPages([...records].reverse(), context, "archive");
}

async function showTextPage(
	context: ExtensionContext,
	title: string,
	lines: readonly string[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await showPage(context, title, [pageSection(lines)], footer);
}

function isPanelBack(data: string): boolean {
	return matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace");
}

function scrollPage(scroll: ScrollView, data: string): boolean {
	const key = parseKey(data) ?? "";
	const distance = new Map<string, number>([
		["up", -1],
		["down", 1],
		["pageUp", -Math.max(1, scroll.viewportHeight - 1)],
		["pageDown", Math.max(1, scroll.viewportHeight - 1)],
	]).get(key);
	if (distance !== undefined) {
		scroll.scrollBy(distance ?? 0);
		return true;
	}
	return scrollPageBoundary(scroll, key);
}

function scrollPageBoundary(scroll: ScrollView, key: string): boolean {
	if (key === "home") {
		scroll.scrollToStart();
		return true;
	}
	if (key === "end") {
		scroll.scrollToEnd();
		return true;
	}
	return false;
}

function addPageContent(container: Container, theme: Theme, title: string, sections: readonly PageSection[]): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	addPageSections(container, theme, sections);
}

function addPageSections(container: Container, theme: Theme, sections: readonly PageSection[]): void {
	const visibleSections = sections.filter((section) => section.lines.some((line) => line.trim().length > 0));
	for (const [index, section] of visibleSections.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		if (section.heading !== undefined) {
			container.addChild(new Text(theme.fg("accent", theme.bold(section.heading)), 1, 0));
		}
		container.addChild(new Text(theme.fg("muted", section.lines.join("\n")), 1, 0));
	}
}

async function showPage(
	context: ExtensionContext,
	title: string,
	sections: readonly PageSection[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await context.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const content = new Container();
		addPageContent(content, theme, title, sections);
		const scroll = new ScrollView(content, { overscroll: "contain", scrollbar: "auto" });
		const footerContainer = new Container();
		addPanelKeybindings(footerContainer, theme, footer);
		const page = new VStack([scroll, footerContainer]);
		// SAFETY: The custom page adds only the input handler while preserving VStack and ScrollView layout contracts.
		const interactivePage = page as VStack & { handleInput: (data: string) => void };
		interactivePage.handleInput = (data: string): void => {
			if (scrollPage(scroll, data)) return;
			if (isPanelBack(data)) done();
		};
		return interactivePage;
	});
}
type InputActionKind =
	| "amend-terms"
	| "record-review"
	| "cancel"
	| "fail-work"
	| "run-oracle"
	| "rename-work"
	| "amend-budget";
const INPUT_ACTION_KINDS: readonly InputActionKind[] = [
	"amend-terms",
	"record-review",
	"cancel",
	"fail-work",
	"run-oracle",
	"rename-work",
	"amend-budget",
];

async function actionInput(action: Action, context: ExtensionContext): Promise<JsonObject | undefined | null> {
	if (!isInputActionKind(action.kind)) return {};
	const handlers = {
		"amend-terms": () => amendTermsInput(context),
		"record-review": () => recordReviewInput(context),
		cancel: () => cancelInput(context),
		"fail-work": () => simpleTextInput(context, "Failure reason", "reason"),
		"run-oracle": () => simpleTextInput(context, "Oracle review subject", "subject", "Review this Work"),
		"rename-work": () => simpleTextInput(context, "New Work title", "title"),
		"amend-budget": () => amendBudgetInput(action, context),
	} satisfies Record<InputActionKind, () => Promise<JsonObject | undefined | null>>;
	return handlers[action.kind]();
}

function isInputActionKind(value: Action["kind"]): value is InputActionKind {
	return INPUT_ACTION_KINDS.some((kind) => kind === value);
}

async function amendTermsInput(context: ExtensionContext): Promise<JsonObject | null> {
	const field = await context.ui.select("Term to amend:", [
		"objective",
		"context",
		"scope",
		"acceptanceCriteria",
		"constraints",
		"validation",
		"allowedPaths",
	]);
	if (field === undefined) return null;
	return ["acceptanceCriteria", "constraints", "validation", "allowedPaths"].includes(field)
		? listTermInput(context, field)
		: scalarTermInput(context, field);
}

async function listTermInput(context: ExtensionContext, field: string): Promise<JsonObject | null> {
	const value = await context.ui.editor(`${field}, one item per line:`, "");
	return value === undefined ? null : { [field]: splitInputLines(value) };
}

async function scalarTermInput(context: ExtensionContext, field: string): Promise<JsonObject | null> {
	const value = await context.ui.input(`${field}:`, "");
	return value === undefined ? null : { [field]: value };
}

function splitInputLines(value: string): readonly string[] {
	return value
		.split("\n")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

async function recordReviewInput(context: ExtensionContext): Promise<JsonObject | null> {
	const status = await context.ui.select("Provider review result:", ["changes-requested", "merged", "closed"]);
	if (status === undefined) return null;
	const feedback = await context.ui.editor("Feedback, one item per line:", "");
	return { status, feedback: splitInputLines(feedback ?? "") };
}

async function cancelInput(context: ExtensionContext): Promise<JsonObject | null> {
	const confirmed = await context.ui.confirm("Cancel?", "This records an explicit cancellation.");
	return confirmed ? {} : null;
}

async function simpleTextInput(
	context: ExtensionContext,
	label: string,
	key: string,
	placeholder = "",
): Promise<JsonObject | null> {
	const value = await context.ui.input(`${label}:`, placeholder);
	return value === undefined ? null : { [key]: value };
}

async function amendBudgetInput(action: Action, context: ExtensionContext): Promise<JsonObject | undefined | null> {
	const value = await context.ui.input("New maximum token budget:", "");
	if (value === undefined) return null;
	const maxTokens = Number(value);
	if (Number.isSafeInteger(maxTokens) && maxTokens > 0) return { maxTokens };
	context.ui.notify("Enter a positive whole-number token budget.", "error");
	return actionInput(action, context);
}

function renderDashboard(work: readonly WorkSummary[]): string {
	if (work.length === 0) {
		return "Khala: no Work has been submitted.";
	}
	return [
		"Khala",
		...work.map((item) => `${item.state.padEnd(16)} ${item.title} (${item.workId}): ${item.nextAction}`),
	].join("\n");
}
