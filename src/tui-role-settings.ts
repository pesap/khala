import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { type GovernedRole, isConclaveMode, type RoleSetting, type RoleSettingsMap } from "./model.js";
import { selectRoleModel } from "./role-model-selector.js";
import { addHeading, addPanelKeybindings, selectableComponent, selectorTheme } from "./tui-pages.js";
import { selectionMarker, tableCell } from "./tui-work-table.js";

export type RoleSettingsController = Readonly<{
	get: () => RoleSettingsMap;
	set: (role: GovernedRole, setting: RoleSetting, value: string) => void | Promise<void>;
}>;

const ROLE_ORDER: readonly GovernedRole[] = ["conclave", "executor", "observer", "oracle"];
const ROLE_LABELS = {
	conclave: "Conclave",
	executor: "Executor",
	observer: "Observer",
	oracle: "Oracle",
} satisfies Readonly<Record<GovernedRole, string>>;
const ROLE_TABLE_GAP = 2;
type RoleTableLayout = Readonly<{ role: number; model: number; thinking: number }>;
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
type RoleSettingsSnapshot = {
	[Role in GovernedRole]: Readonly<{ role: Role; current: RoleSettingsMap[Role] }>;
}[GovernedRole];

function roleSettingsSnapshot(settings: RoleSettingsMap, role: GovernedRole): RoleSettingsSnapshot {
	const snapshots = {
		conclave: { role: "conclave", current: settings.conclave },
		executor: { role: "executor", current: settings.executor },
		observer: { role: "observer", current: settings.observer },
		oracle: { role: "oracle", current: settings.oracle },
	} satisfies Record<GovernedRole, RoleSettingsSnapshot>;
	return snapshots[role];
}

function selectedRoleSetting(value: string): RoleSetting {
	return value.startsWith("Model")
		? "model"
		: value.startsWith("Thinking")
			? "thinking"
			: value.startsWith("Invocation mode")
				? "mode"
				: "usdMax";
}

function validateRoleSettingValue(role: GovernedRole, setting: RoleSetting, value: string): void {
	if (setting === "mode") return validateConclaveMode(role, value);
	if (setting === "usdMax") validateUsdMax(value);
}

function validateConclaveMode(role: GovernedRole, value: string): void {
	if (role !== "conclave" || !isConclaveMode(value)) throw new Error("Conclave mode must be headless or subagent.");
}

function validateUsdMax(value: string): void {
	const usdMax = Number(value);
	if (!Number.isFinite(usdMax) || usdMax <= 0) throw new Error("USD max must be a positive number.");
}

function roleSettingLabel(setting: RoleSetting): string {
	return setting === "usdMax" ? "USD max" : setting === "mode" ? "invocation mode" : setting;
}

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

function roleSettingOptions(snapshot: RoleSettingsSnapshot): string[] {
	const { role, current } = snapshot;
	const options = [
		`Model: ${current.model || "not configured"}`,
		`Thinking: ${current.thinking}`,
		`USD max: $${(current.usdMax ?? 5).toFixed(2)}`,
	];
	if (role === "conclave") options.push(conclaveModeOption(current.mode));
	return options;
}

function conclaveModeOption(mode: RoleSettingsMap["conclave"]["mode"]): string {
	return `Invocation mode: ${mode === "subagent" ? "Subagent (current session)" : "Headless (separate process)"}`;
}

async function editRoleSetting(
	controller: RoleSettingsController,
	context: ExtensionContext,
	snapshot: RoleSettingsSnapshot,
): Promise<void> {
	const selected = await selectRoleOption(
		context,
		`${ROLE_LABELS[snapshot.role]} settings:`,
		roleSettingOptions(snapshot),
	);
	if (selected === undefined) return;
	await saveSelectedRoleSetting(controller, context, snapshot.role, snapshot.current, selectedRoleSetting(selected));
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

function roleSettingValue(
	context: ExtensionContext,
	role: GovernedRole,
	current: RoleSettingsMap[GovernedRole],
	setting: RoleSetting,
): Promise<string | undefined> {
	const editors = {
		model: () => selectRoleModelValue(context, current.model),
		thinking: () => selectRoleThinking(context, role, current),
		usdMax: () => selectUsdMax(context, role, current.usdMax),
		mode: () => selectConclaveMode(context, role),
	} satisfies Record<RoleSetting, () => Promise<string | undefined>>;
	return editors[setting]();
}

async function selectRoleModelValue(context: ExtensionContext, current: string): Promise<string | undefined> {
	const selectedModel = await selectRoleModel(context, current);
	return selectedModel === undefined ? undefined : `${selectedModel.provider}/${selectedModel.id}`;
}

async function selectUsdMax(
	context: ExtensionContext,
	role: GovernedRole,
	current: number,
): Promise<string | undefined> {
	return (await context.ui.input(`${ROLE_LABELS[role]} USD max:`, (current ?? 5).toFixed(2)))?.trim();
}

async function selectConclaveMode(context: ExtensionContext, role: GovernedRole): Promise<string | undefined> {
	if (role !== "conclave") throw new Error("Only Conclave supports an invocation mode.");
	const selected = await selectRoleOption(context, "Conclave invocation mode:", [
		"Headless (separate process)",
		"Subagent (current session)",
	]);
	return selected === "Headless (separate process)"
		? "headless"
		: selected === "Subagent (current session)"
			? "subagent"
			: undefined;
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
		validateRoleSettingValue(role, setting, value);
		await controller.set(role, setting, value);
		context.ui.notify(`${ROLE_LABELS[role]} ${roleSettingLabel(setting)} updated.`, "info");
	} catch (error) {
		context.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function showRoleSettings(controller: RoleSettingsController, context: ExtensionContext): Promise<void> {
	for (;;) {
		const settings = controller.get();
		const role = await selectRoleTable(context, settings);
		if (role === undefined) return;
		await editRoleSetting(controller, context, roleSettingsSnapshot(settings, role));
	}
}
