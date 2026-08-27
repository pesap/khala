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
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

// oxlint-disable-next-line complexity
function workTableLayout(width: number): WorkTableLayout {
	if (width >= 95) return WIDE_WORK_TABLE_COLUMNS;
	const available = Math.max(1, width - 2);
	if (available >= 33) {
		const id = available >= 43 ? 8 : 6;
		const state = available >= 43 ? 10 : 7;
		const execution = 9;
		return {
			title: Math.max(1, available - id - state - execution - 6),
			id,
			state,
			execution,
			showId: true,
		};
	}
	const state = available >= 24 ? 6 : Math.max(1, Math.min(8, Math.floor((available - 4) / 4)));
	const execution =
		available >= 24
			? Math.min(9, Math.max(1, available - state - 8))
			: Math.max(1, Math.min(9, Math.floor((available - state - 4) / 2)));
	return {
		title: Math.max(1, available - state - execution - 4),
		id: 0,
		state,
		execution,
		showId: false,
	};
}

function hasWorkFailure(item: WorkSummary): boolean {
	return item.hasFailure === true || (item.state === "stopped" && item.stopReason === "failed");
}

// oxlint-disable-next-line complexity
function workState(item: WorkSummary): WorkStatus {
	if (item.state === "stopped" && item.stopReason === "failed") return { label: "stopped", tone: "failure" };
	if (item.state === "stopped") return { label: "stopped", tone: "inactive" };
	if (hasWorkFailure(item)) return { label: formatStatus(item.state), tone: "failure" };
	if (item.state === "succeeded") return { label: "succeeded", tone: "success" };
	if (item.state === "queued" || item.state === "awaiting-review")
		return { label: formatStatus(item.state), tone: "waiting" };
	return { label: formatStatus(item.state), tone: "active" };
}

// oxlint-disable-next-line complexity
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

// oxlint-disable-next-line complexity
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
	const pickerState: WorkPickerState = {};
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
	selectedWorkId?: string | undefined;
	filter?: string | undefined;
};

async function pickWork(
	work: readonly WorkSummary[],
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
	pickerState: WorkPickerState,
): Promise<string | "settings" | null> {
	// oxlint-disable-next-line complexity
	return context.ui.custom<string | "settings" | null>((tui, theme, _keybindings, done) => {
		const filterInput = new Input();
		filterInput.focused = true;
		filterInput.setValue(pickerState.filter ?? "");
		const availableWork = work.filter((item) => !isHiddenWork(item));
		let filtered = filterWork(availableWork, filterInput.getValue());
		let selectedIndex = 0;
		let tableRows: readonly Readonly<{ item: WorkSummary; selected: boolean }>[] = [];
		let listMessages: readonly string[] = [];
		const listContainer: Component = {
			render: (width: number) => {
				const layout = workTableLayout(width);
				return [
					workTableHeader(theme, layout),
					...tableRows.map(({ item, selected }) => workTableRow(theme, item, selected, layout)),
					...listMessages,
				].map((line) => truncateToWidth(line, width, ""));
			},
			invalidate: () => {},
		};
		// oxlint-disable-next-line complexity
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
				if (item !== undefined) rows.push({ item, selected: index === selectedIndex });
			}
			if (startIndex > 0 || endIndex < filtered.length) {
				messages.push(theme.fg("muted", `  ${selectedIndex + 1} of ${filtered.length}`));
			}
			if (filtered.length === 0) {
				messages.push(theme.fg("muted", availableWork.length === 0 ? "  No active Work" : "  No matching Work"));
			}
			tableRows = rows;
			listMessages = messages;
			tui.requestRender();
		};
		const updateFilter = (): void => {
			const query = filterInput.getValue().trim();
			pickerState.filter = query;
			filtered = filterWork(availableWork, query);
			selectedIndex = query.length === 0 ? Math.min(selectedIndex, Math.max(0, filtered.length - 1)) : 0;
			updateList();
		};
		const finish = (value: string | "settings" | null): void => {
			if (value !== null && value !== "settings") pickerState.selectedWorkId = value;
			done(value);
		};
		const restoredIndex =
			filterInput.getValue().trim().length === 0 && pickerState.selectedWorkId !== undefined
				? filtered.findIndex((item) => item.workId === pickerState.selectedWorkId)
				: -1;
		if (restoredIndex >= 0) selectedIndex = restoredIndex;
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Work")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(filterInput);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, workPickerKeybindings(keybindings));
		updateList();
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			// oxlint-disable-next-line complexity
			handleInput: (data: string) => {
				if (filterInput.getValue().length === 0 && parseKey(data) === keybindings.roleSettings) {
					finish("settings");
					return;
				}
				if (data === "?") {
					context.ui.notify?.("Type to filter Work by title, ID, or state.", "info");
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
				if (matchesKey(data, "backspace") && filterInput.getValue().length === 0) {
					finish(null);
					return;
				}
				const previousFilter = filterInput.getValue();
				filterInput.handleInput(data);
				if (filterInput.getValue() !== previousFilter) updateFilter();
			},
		};
	});
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

function workPickerKeybindings(keybindings: KhalaConfig["keybindings"]): string {
	return `type to filter  home first  up/down move  enter open  ? help  ${keybindings.roleSettings} settings  escape/ctrl+c/backspace back`;
}

function addPanelKeybindings(container: Container, theme: Theme, footer: string): Text {
	const keybindings = new Text(theme.fg("dim", footer), 1, 0);
	container.addChild(keybindings);
	container.addChild(new Spacer(1));
	return keybindings;
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

type WorkSection = "actions" | "evidence" | "archive" | "review-comments" | "blocking-signal";

// oxlint-disable-next-line complexity
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
		const section = await pickSection(work, records, context, keybindings);
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
			await showArchive(service, context, work, actor, keybindings);
			continue;
		}
		if (section === "review-comments") {
			await showReviewComments(providerReviewComments(records), context);
			continue;
		}
		await showBlockingSignal(work, context);
	}
}

async function pickSection(
	work: WorkView,
	records: readonly RecordView[],
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
): Promise<WorkSection | "back" | null> {
	const reviewComments = providerReviewComments(records);
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		{ value: "archive", label: "Archive" },
		...(hasCurrentBlockedSignal(work) ? [{ value: "blocking-signal", label: "Inspect blocking signal" }] : []),
	];
	// oxlint-disable-next-line complexity
	return context.ui.custom<WorkSection | "back" | null>((tui, theme, _keybindings, done) => {
		const execution = work.execution;
		const rows: Array<readonly [string, string]> = [["Work", formatWorkState(work)]];
		if (work.mission !== undefined && work.missionState !== undefined) {
			rows.push(["Mission", formatMissionState(work.missionState)]);
		}
		if (execution !== undefined) {
			rows.push(["Execution", formatExecutionState(execution)]);
			if (shouldShowRuntime(execution)) rows.push(["Runtime", formatRuntimeState(execution)]);
		}
		if (work.nextAction.trim().length > 0) rows.push(["Next", presentEvidenceText(work.nextAction)]);
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
			reviewComments.length === 0 ? NAVIGATION_FOOTER : `${NAVIGATION_FOOTER}  ${keybindings.comments} comments`;
		addPanelKeybindings(container, theme, footer);
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

function shouldShowRuntime(execution: NonNullable<WorkView["execution"]>): boolean {
	return execution.runtimeState !== undefined && !["completed", "failed", "stopped"].includes(execution.state);
}

// oxlint-disable-next-line complexity
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
	const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
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
	if (selected === null || selected === "back") return;
	const action = actions.find((candidate) => candidate.id === selected);
	if (action === undefined) return;
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

function displayActionLabel(action: Action): string {
	const labels = {
		admit: "Admit",
		"launch-observer": "Launch observer",
		"record-assessment": "Record assessment",
		"start-execution": "Start execution",
		"record-signal": "Record signal",
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
			const rows: Array<readonly [string, string]> = [
				["Status", display.status],
				["Progress", display.progress],
				["Doing", display.doing],
				["Next", display.next],
			];
			if (display.reason !== undefined) rows.splice(3, 0, ["Reason", display.reason]);
			body.setText(theme.fg("muted", formatFieldRows(rows).join("\n")));
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
				// oxlint-disable-next-line complexity
				.then((result) => {
					if ("error" in result) {
						update({
							status: "failed",
							progress: "stopped",
							doing: "Khala could not restore the Executor",
							reason: "The recovery operation could not be completed",
							next:
								result.error.code === "revision-conflict"
									? "Refresh and try again."
									: "Inspect Evidence for the failure details.",
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
									next: "Inspect Evidence and decide what to do next.",
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
											? "No action is needed. Khala will continue automatically."
											: awaitingReview
												? "Review the Work when the provider responds."
												: "No action is needed. Khala will continue automatically.",
								},
					);
				})
				.catch(() =>
					update({
						status: "failed",
						progress: "stopped",
						doing: "Khala could not restore the Executor",
						reason: "The recovery operation ended unexpectedly",
						next: "Inspect Evidence for the failure details.",
					}),
				);
		});
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			// oxlint-disable-next-line complexity
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

// oxlint-disable-next-line complexity
async function showRoleSettings(controller: RoleSettingsController, context: ExtensionContext): Promise<void> {
	for (;;) {
		const settings = controller.get();
		const roleOptions = ROLE_ORDER.map((role) => {
			const current = settings[role];
			return `${ROLE_LABELS[role]}: ${current.model || "model not configured"} (${current.thinking})`;
		});
		const selectedRole = await selectRoleOption(context, "Role settings:", roleOptions);
		if (selectedRole === undefined) return;
		const roleIndex = roleOptions.indexOf(selectedRole);
		const role = ROLE_ORDER[roleIndex];
		if (role === undefined) return;

		const current = controller.get()[role];
		const selectedSetting = await selectRoleOption(context, `${ROLE_LABELS[role]} settings:`, [
			`Model: ${current.model || "not configured"}`,
			`Thinking: ${current.thinking}`,
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

// oxlint-disable-next-line complexity
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
	return execution.state === "running" ? "running" : formatStatus(execution.state);
}

// oxlint-disable-next-line complexity
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

type RecordListMode = "evidence" | "archive";
type RecordListEntry = Readonly<{ kind: "record"; record: RecordView }> | Readonly<{ kind: "comments"; count: number }>;
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

// oxlint-disable-next-line complexity
function providerReviewComments(records: readonly RecordView[]): readonly ProviderReviewComment[] {
	for (const record of [...records].reverse()) {
		if (record.kind !== "observation") continue;
		const payload =
			readPayloadObject(readPayloadObjectValue(record.payload), "details") ??
			readPayloadObject(readPayloadObjectValue(record.payload), "providerObservation");
		const comments = readPayloadObjects(payload, "comments");
		const parsed = comments
			.map(readProviderReviewComment)
			.filter((comment): comment is ProviderReviewComment => comment !== undefined);
		if (parsed.length > 0) return parsed;
	}
	return [];
}

// oxlint-disable-next-line complexity
function readProviderReviewComment(value: JsonObject): ProviderReviewComment | undefined {
	const id = readObjectText(value, "id");
	const body = readObjectText(value, "body");
	if (id === undefined || body === undefined) return undefined;
	const comment: MutableProviderReviewComment = { id, body };
	const author = readObjectText(value, "author");
	const authorAssociation = readObjectText(value, "authorAssociation");
	const createdAt = readObjectText(value, "createdAt");
	const url = readObjectText(value, "url");
	const state = readObjectText(value, "state");
	const source = readCommentSource(value);
	const location = readObjectText(value, "location");
	const minimized = readObjectBoolean(value, "minimized");
	if (author !== undefined) comment.author = author;
	if (authorAssociation !== undefined) comment.authorAssociation = authorAssociation;
	if (createdAt !== undefined) comment.createdAt = createdAt;
	if (url !== undefined) comment.url = url;
	if (state !== undefined) comment.state = state;
	if (source !== undefined) comment.source = source;
	if (location !== undefined) comment.location = location;
	if (minimized !== undefined) comment.minimized = minimized;
	return comment;
}

function readCommentSource(value: JsonObject): ProviderReviewComment["source"] {
	const source = readObjectText(value, "source");
	return source === "issue-comment" || source === "review" || source === "inline" ? source : undefined;
}

function readObjectBoolean(object: JsonObject | undefined, key: string): boolean | undefined {
	const value = object?.[key];
	return value === true || value === false ? value : undefined;
}

// oxlint-disable-next-line complexity
function hasCurrentBlockedSignal(work: WorkView): boolean {
	const signal = work.lastSignal;
	return (
		signal !== undefined &&
		work.execution !== undefined &&
		work.execution.state === "blocked" &&
		signal.kind === "blocked" &&
		signal.executionId === work.execution.executionId
	);
}

const EVIDENCE_RECORD_KINDS: readonly RecordKind[] = [
	"assessment",
	"learning",
	"signal",
	"review-request",
	"observation",
	"delivery",
	"verdict",
	"oracle-review",
	"outcome",
	"error",
];

// oxlint-disable-next-line complexity
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
	const evidenceRecords = selectRelevantEvidence(work, records);
	const comments = providerReviewComments(records);
	for (;;) {
		const selected = await selectRecordPanel(
			evidenceRecords,
			comments.length,
			context,
			"evidence",
			keybindings,
			formatEvidenceSupplement(work),
		);
		if (selected === null) return;
		if (selected === "comments") {
			await showReviewComments(comments, context);
			continue;
		}
		const record = evidenceRecords.find((candidate) => String(candidate.sequence) === selected);
		if (record === undefined) return;
		const page = formatRecordPage(record);
		await showPage(context, page.title, page.sections);
	}
}

// oxlint-disable-next-line complexity
function selectRelevantEvidence(work: WorkView, records: readonly RecordView[]): readonly RecordView[] {
	const selected = new Map<number, RecordView>();
	const missionId = work.mission?.missionId;
	const executionId = work.execution?.executionId;
	const currentReviewProviderId = work.reviewRequest?.providerId;
	const currentReviewUrl = work.reviewRequest?.url;
	const add = (record: RecordView | undefined): void => {
		if (record !== undefined) selected.set(record.sequence, record);
	};
	const latest = (predicate: (record: RecordView) => boolean): RecordView | undefined =>
		[...records].reverse().find(predicate);
	const isCurrentBinding = (record: RecordView): boolean =>
		(record.executionId !== undefined && record.executionId === executionId) ||
		(record.missionId !== undefined && record.missionId === missionId);
	const isProviderObservation = (record: RecordView): boolean =>
		record.kind === "observation" && readPayloadBoolean(record.payload, "changed") === true;

	for (const record of records) {
		if (!EVIDENCE_RECORD_KINDS.includes(record.kind)) continue;
		if (isCurrentBinding(record) || isProviderObservation(record) || record.evidenceRefs.length > 0) add(record);
	}
	add(latest((record) => record.kind === "error" && (isCurrentBinding(record) || work.lastError !== undefined)));
	add(
		latest(
			(record) =>
				record.kind === "signal" &&
				(executionId === undefined || isCurrentBinding(record) || record.executionId === executionId),
		),
	);
	add(
		latest(
			// oxlint-disable-next-line complexity
			(record) =>
				record.kind === "review-request" &&
				((currentReviewProviderId !== undefined &&
					readPayloadText(record.payload, "providerId") === currentReviewProviderId) ||
					(currentReviewUrl !== undefined && record.evidenceRefs.includes(currentReviewUrl))),
		),
	);
	for (const record of records) {
		if (record.kind === "observation" && readPayloadBoolean(record.payload, "changed") === true) add(record);
		if (["delivery", "verdict", "oracle-review", "outcome"].includes(record.kind) && isCurrentBinding(record))
			add(record);
	}
	if (selected.size === 0) add([...records].reverse().find((record) => record.evidenceRefs.length > 0));
	return [...selected.values()].sort((left, right) => left.sequence - right.sequence);
}

function formatEvidenceSupplement(work: WorkView): readonly PageSection[] {
	const next = presentEvidenceText(work.nextAction);
	return next.length === 0 ? [] : [pageSection([next], "Next")];
}

// oxlint-disable-next-line complexity
async function showReviewComments(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<void> {
	if (comments.length === 0) return;
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
				label: `${comment.author ?? "unknown author"} ${compactRecordSummary(comment.body)}`.trim(),
			})),
			Math.min(6, comments.length),
			selectorTheme(theme),
		);
		const container = new Container();
		addHeading(container, theme, "Review comments");
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

// oxlint-disable-next-line complexity
function formatReviewCommentSections(comment: ProviderReviewComment): readonly PageSection[] {
	const details: string[] = [];
	if (comment.author !== undefined) {
		details.push(
			`author: ${comment.author}${comment.authorAssociation === undefined ? "" : ` (${comment.authorAssociation})`}`,
		);
	}
	if (comment.createdAt !== undefined) details.push(`created: ${formatRecordedAt(comment.createdAt)}`);
	if (comment.source !== undefined) details.push(`source: ${comment.source}`);
	if (comment.location !== undefined) details.push(`location: ${comment.location}`);
	if (comment.state !== undefined) details.push(`state: ${comment.state}`);
	if (comment.minimized !== undefined) details.push(`minimized: ${comment.minimized ? "yes" : "no"}`);
	return [
		...(details.length === 0 ? [] : [pageSection(details)]),
		pageSection([comment.body], "Comment"),
		...(comment.url === undefined ? [] : [pageSection([`url: ${comment.url}`], "Source")]),
	];
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

// oxlint-disable-next-line complexity
async function selectRecordPanel(
	records: readonly RecordView[],
	commentCount: number,
	context: ExtensionContext,
	mode: RecordListMode,
	keybindings: KhalaConfig["keybindings"],
	supplement: readonly PageSection[] = [],
): Promise<string | "comments" | null> {
	const entries: readonly RecordListEntry[] = [
		...records.map((record) => ({ kind: "record" as const, record })),
		...(commentCount === 0 ? [] : [{ kind: "comments" as const, count: commentCount }]),
	];
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
	return context.ui.custom<string | "comments" | null>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const list = createRecordList(entries, mode, theme, () => selectedIndex);
		const container = new Container();
		addHeading(container, theme, title);
		container.addChild(new Spacer(1));
		container.addChild(list);
		if (supplement.length > 0) container.addChild(new Spacer(1));
		addPageSections(container, theme, supplement);
		container.addChild(new Spacer(1));
		const footer =
			commentCount === 0 ? RECORD_NAVIGATION_FOOTER : `${RECORD_NAVIGATION_FOOTER}  ${keybindings.comments} comments`;
		addPanelKeybindings(container, theme, footer);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			// oxlint-disable-next-line complexity
			handleInput: (data: string) => {
				if (commentCount > 0 && parseKey(data) === keybindings.comments) {
					done("comments");
					return;
				}
				if (matchesKey(data, "up") || matchesKey(data, "down")) {
					selectedIndex = nextRecordIndex(selectedIndex, entries.length, matchesKey(data, "up"));
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "enter")) {
					const entry = entries[selectedIndex];
					if (entry?.kind === "comments") done("comments");
					else if (entry?.kind === "record") done(String(entry.record.sequence));
					return;
				}
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace")) done(null);
			},
		};
	});
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
	if (entry.kind === "comments") {
		return markRecordListEntry(["  Review comments", `    ${entry.count} available`], selected, theme);
	}
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

// oxlint-disable-next-line complexity
function formatRecordPage(record: RecordView): RecordPage {
	const metadata: Array<readonly [string, string]> = [
		["Recorded", formatRecordedAt(record.recordedAt)],
		["Actor", record.actor],
		["Record number", String(record.recordNumber)],
	];
	if (record.missionRecordNumber !== undefined)
		metadata.push(["Mission record number", String(record.missionRecordNumber)]);
	metadata.push(["Record ID", record.id], ["Work ID", record.workId]);
	if (record.missionId !== undefined) metadata.push(["Mission ID", record.missionId]);
	if (record.executionId !== undefined) metadata.push(["Execution ID", record.executionId]);
	metadata.push(["Payload version", String(record.payloadVersion)]);
	const payloadFields = recordDetailPayloadFields(record);
	const structuredFields = formatStructuredFields(record.payload, payloadFields.displayed);
	const evidenceReferences =
		payloadFields.displayedEvidence !== undefined &&
		sameStringList(payloadFields.displayedEvidence, record.evidenceRefs)
			? []
			: record.evidenceRefs;
	return {
		title: recordTitle(record),
		sections: [
			pageSection(formatFieldRows(metadata)),
			...payloadFields.sections,
			...(structuredFields.length === 0 ? [] : [pageSection(structuredFields, "Structured fields")]),
			...(evidenceReferences.length === 0 ? [] : [pageSection(evidenceReferences, "Evidence references")]),
		],
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

// oxlint-disable-next-line complexity
function recordDetailPayloadFields(record: RecordView): RecordDetailFields {
	const payload = readPayloadObjectValue(record.payload);
	if (record.kind === "signal") {
		const response = readObjectText(payload, "summary");
		const evidence = readObjectTextList(payload, "evidence") ?? record.evidenceRefs;
		const sections = [
			...(record.summary.trim().length === 0 || response === record.summary
				? []
				: [pageSection([record.summary], "Summary")]),
			...(response === undefined
				? record.summary.trim().length === 0
					? []
					: [pageSection([record.summary], "Executor response")]
				: [pageSection([response], "Executor response")]),
			...(evidence.length === 0 ? [] : [pageSection(evidence, "Evidence")]),
		];
		return { sections, displayed: ["kind", "summary", "evidence"], displayedEvidence: evidence };
	}
	if (record.kind === "error") {
		const learning = readPayloadObject(payload, "learning");
		const failure = readObjectText(learning, "failure");
		const remediation = readObjectText(payload, "remediation");
		const sections = [
			...formatRecordSummarySections(record, payload, "Error"),
			...(remediation === undefined ? [] : [pageSection([remediation], "Recovery")]),
			...(failure === undefined || failure.trim() === record.summary.trim() ? [] : [pageSection([failure], "Failure")]),
		];
		return { sections, displayed: ["summary", "remediation", "learning", "evidenceRefs"] };
	}
	if (record.kind === "oracle-review") return formatOracleDetailFields(record, payload);
	return {
		sections: formatRecordSummarySections(record, payload),
		displayed: ["summary"],
	};
}

// oxlint-disable-next-line complexity
function formatRecordSummarySections(
	record: RecordView,
	payload: JsonObject | undefined,
	payloadHeading = "Payload summary",
): readonly PageSection[] {
	const sections: PageSection[] = [];
	if (record.summary.trim().length > 0) sections.push(pageSection([record.summary], "Summary"));
	const payloadSummary = readObjectText(payload, "summary");
	if (payloadSummary !== undefined && payloadSummary.trim() !== record.summary.trim()) {
		sections.push(pageSection([payloadSummary], payloadHeading));
	}
	return sections;
}

// oxlint-disable-next-line complexity
function formatOracleDetailFields(record: RecordView, payload: JsonObject | undefined): RecordDetailFields {
	const findings = readPayloadObjects(payload, "findings");
	const gaps = readObjectTextList(payload, "validationGaps") ?? [];
	const output = readObjectText(payload, "output");
	const duration = readObjectNumber(payload, "durationMs");
	const verdict = readObjectText(payload, "verdict");
	return {
		sections: [
			...formatRecordSummarySections(record, payload),
			...(verdict === undefined ? [] : [pageSection(formatFieldRows([["Verdict", verdict]]))]),
			...(findings.length === 0 ? [] : [pageSection(formatFindings(findings), "Findings")]),
			...(gaps.length === 0
				? []
				: [
						pageSection(
							gaps.map((gap, index) => `${index + 1}  ${gap}`),
							"Validation gaps",
						),
					]),
			...(output === undefined ? [] : [pageSection([output], "Model response")]),
			...(duration === undefined ? [] : [pageSection(formatFieldRows([["Duration", `${duration} ms`]]))]),
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

// oxlint-disable-next-line complexity
function omitPayloadFields(payload: JsonValue, displayed: readonly string[]): JsonValue | undefined {
	if (!isJsonObject(payload)) return payload;
	const excluded = new Set(displayed);
	const remaining: MutableJsonObject = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value !== undefined && !excluded.has(key)) remaining[key] = value;
	}
	return Object.keys(remaining).length === 0 ? undefined : remaining;
}

// oxlint-disable-next-line complexity
function recordKindLabel(record: RecordView): string {
	if (record.kind === "signal") {
		const signalKind = readPayloadText(record.payload, "kind");
		if (signalKind === "ready" || signalKind === "progress" || signalKind === "blocked") return signalKind;
	}
	const labels = {
		submission: "submission",
		assessment: "assessment",
		learning: "learning",
		mission: "mission",
		"mission-change": "mission change",
		execution: "execution",
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

// oxlint-disable-next-line complexity
function readObjectNumber(object: JsonObject | undefined, key: string): number | undefined {
	const value = object?.[key];
	return value !== undefined && value === Number(value) && Number.isFinite(Number(value)) ? Number(value) : undefined;
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

// oxlint-disable-next-line complexity
function formatErrorSections(error: ErrorEnvelope | undefined): readonly PageSection[] {
	if (error === undefined) return [];
	const nextStep = [
		...(error.remediation.trim().length === 0 ? [] : [presentEvidenceText(error.remediation)]),
		...(error.learning?.missionSpecificity === undefined
			? []
			: [`learning: ${presentEvidenceText(error.learning.missionSpecificity)}`]),
	];
	return [
		...(error.summary.trim().length === 0 ? [] : [pageSection([presentEvidenceText(error.summary)], "Error")]),
		...(nextStep.length === 0 ? [] : [pageSection(nextStep, "Next step")]),
	];
}

function presentEvidenceText(value: string): string {
	return value.trim();
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

// oxlint-disable-next-line complexity
async function showArchive(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
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
	const newestFirst = [...records].reverse();
	for (;;) {
		const selected = await selectRecordPanel(newestFirst, 0, context, "archive", keybindings);
		if (selected === null || selected === "comments") return;
		const record = newestFirst.find((candidate) => String(candidate.sequence) === selected);
		if (record === undefined) return;
		const page = formatRecordPage(record);
		await showPage(context, page.title, page.sections);
	}
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

// oxlint-disable-next-line complexity
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
		...work.map((item) => `${item.state.padEnd(16)} ${item.title} (${item.workId}): ${item.nextAction}`),
	].join("\n");
}
