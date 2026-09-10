import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	parseKey,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { KhalaArchiveView } from "./archive-view.js";
import type { KhalaConfig } from "./config.js";
import type { Actor, WorkSummary } from "./model.js";
import type { ApplicationService } from "./service.js";
import { type ActionRunner, createActionRunner } from "./tui-actions.js";
import { addPanelKeybindings, showTextPage } from "./tui-pages.js";
import { type RoleSettingsController, showRoleSettings } from "./tui-role-settings.js";
import { showArchiveWork, showWork } from "./tui-work.js";
import { hasWorkFailure, isHiddenWork, workTableHeader, workTableLayout, workTableRow } from "./tui-work-table.js";

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
	const runAction = createActionRunner(service, context, actor);
	const effectiveKeybindings = normalizeKeybindings(keybindings);
	for (;;) {
		const result = await pickWork(() => service.listWork(), context, effectiveKeybindings, pickerState, {
			showSettings: true,
		});
		if (result === null) return;
		await handlePickerResult(result, service, context, actor, effectiveKeybindings, roleSettings, runAction);
	}
}

async function handlePickerResult(
	result: Exclude<WorkPickerResult, null>,
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
	roleSettings: RoleSettingsController | undefined,
	runAction: ActionRunner,
): Promise<void> {
	if (result === "settings") {
		if (roleSettings !== undefined) await showRoleSettings(roleSettings, context);
		return;
	}
	if (result === "help") {
		await showTextPage(context, "Work picker help", workPickerHelp(keybindings));
		return;
	}
	await showWork(service, context, result, actor, keybindings, runAction);
}

type WorkFilter = "Work" | "Needs attention" | "Review" | "History";
const WORK_FILTERS: readonly WorkFilter[] = ["Work", "Needs attention", "Review", "History"];
const WORK_FILTER_PREDICATES = {
	Work: (work) => !isHiddenWork(work),
	"Needs attention": (work) =>
		hasWorkFailure(work) || work.state === "needs-input" || work.executionState === "blocked",
	Review: (work) => work.state === "awaiting-review",
	History: (work) => work.state === "succeeded" || work.state === "stopped",
} satisfies Readonly<Record<WorkFilter, (work: WorkSummary) => boolean>>;

export type WorkPickerState = {
	selectedWorkId?: string | undefined;
	filter?: string | undefined;
	showHistory?: boolean | undefined;
	scope?: WorkFilter;
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
	private setScopeHeading: (scope: WorkFilter) => void = () => {};

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
		this.availableWork = pickerWork(getWork(), pickerState);
		this.filtered = filterWork(this.availableWork, pickerState.filter ?? "");
		this.restoreSelection();
	}

	setHeading(update: (scope: WorkFilter) => void): void {
		this.setScopeHeading = update;
	}

	cycleScope(input: Input, direction: number): void {
		const scope = this.pickerState.scope ?? "Work";
		const index = (WORK_FILTERS.indexOf(scope) + direction + WORK_FILTERS.length) % WORK_FILTERS.length;
		this.pickerState.scope = WORK_FILTERS[index] ?? "Work";
		this.pickerState.showHistory = false;
		this.refresh(input);
		this.setScopeHeading(this.pickerState.scope);
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
		const selectedWorkId = this.pickerState.selectedWorkId ?? this.filtered[this.selectedIndex]?.workId;
		this.pickerState.selectedWorkId = selectedWorkId;
		this.availableWork = pickerWork(this.getWork(), this.pickerState);
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
		this.pickerState.scope = "Work";
		this.refresh(input);
		this.setScopeHeading(this.pickerState.showHistory ? "History" : "Work");
		this.setHistoryFooter(this.pickerState.showHistory === true);
		this.updateList();
	}

	move(movingUp: boolean): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = nextPickerIndex(this.selectedIndex, this.filtered.length, movingUp);
		this.pickerState.selectedWorkId = this.filtered[this.selectedIndex]?.workId;
		this.updateList();
	}

	first(): void {
		this.selectedIndex = 0;
		this.pickerState.selectedWorkId = this.filtered[0]?.workId;
		this.updateList();
	}

	enter(): void {
		const item = this.filtered[this.selectedIndex];
		if (item !== undefined) this.finish(item.workId);
	}

	private restoreSelection(): void {
		this.selectedIndex = refreshedWorkIndex(this.pickerState.selectedWorkId, this.filtered, this.selectedIndex);
	}
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
		handleInput: (data: string) => {
			if (switchWorkFilter(data, filterInput, controller)) return;
			handlePickerInput(data, filterInput, keybindings, showSettings, {
				finish: (value) => controller.finish(value),
				refresh: () => controller.refresh(filterInput),
				toggleHistory: () => controller.toggleHistory(filterInput),
				home: () => controller.first(),
				move: (movingUp) => controller.move(movingUp),
				enter: () => controller.enter(),
				updateFilter: () => controller.updateFilter(filterInput),
			});
		},
	};
}

function switchWorkFilter(data: string, input: Input, controller: WorkPickerController): boolean {
	if (input.getValue().length > 0) return false;
	const bindings = getKeybindings();
	const directions = [
		["tui.editor.cursorLeft", -1],
		["tui.editor.cursorRight", 1],
	] as const;
	const direction = directions.find(([key]) => bindings.matches(data, key));
	if (direction === undefined) return false;
	controller.cycleScope(input, direction[1]);
	return true;
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
		const heading = new Text(theme.fg("accent", theme.bold(pickerState.scope ?? "Work")), 1, 0);
		container.addChild(heading);
		controller.setHeading((scope) => heading.setText(theme.fg("accent", theme.bold(scope))));
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

export function renderDashboard(work: readonly WorkSummary[]): string {
	if (work.length === 0) {
		return "Khala: no Work has been submitted.";
	}
	return [
		"Khala",
		...work.map((item) => `${item.state.padEnd(16)} ${item.title} (${item.workId}): ${item.nextAction}`),
	].join("\n");
}
export function workPickerKeybindings(
	keybindings: KhalaConfig["keybindings"],
	showHistory: boolean,
	showSettings: boolean,
): string {
	const settings = showSettings ? `  ${keybindings.roleSettings} settings when filter is empty` : "";
	return `left/right filters  type to filter  ${keybindings.refresh} refresh  ${keybindings.history} ${showHistory ? "active Work" : "history"} when filter is empty  home first  up/down move  enter open  ${keybindings.help} help when filter is empty${settings}  escape/ctrl+c/backspace back`;
}

export function normalizeKeybindings(keybindings: KhalaConfig["keybindings"]): KhalaConfig["keybindings"] {
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

export function pickerWork(work: readonly WorkSummary[], state: WorkPickerState): readonly WorkSummary[] {
	return state.showHistory ? work : work.filter(WORK_FILTER_PREDICATES[state.scope ?? "Work"]);
}

export function workPickerHelp(keybindings: KhalaConfig["keybindings"], showSettings = true): readonly string[] {
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
