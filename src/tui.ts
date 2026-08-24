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
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { KhalaConfig } from "./config.js";
import type {
	Action,
	Actor,
	GovernedRole,
	JsonObject,
	JsonValue,
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

export async function showKhala(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor = "user",
	keybindings: KhalaConfig["keybindings"] = { filter: "/", help: "?", roleSettings: "r" },
	roleSettings?: RoleSettingsController,
): Promise<void> {
	if (!context.hasUI || context.mode !== "tui") {
		context.ui.notify(renderDashboard(service.listWork()), "info");
		return;
	}
	let filter = "";
	for (;;) {
		const workId = await pickWork(service.listWork(), context, filter, keybindings);
		if (workId === null) {
			return;
		}
		if (workId === "help") {
			await showHelp(context);
			continue;
		}
		if (workId === "filter") {
			filter = (await context.ui.input("Filter Work by title or ID:", filter)) ?? filter;
			continue;
		}
		if (workId === "settings") {
			if (roleSettings !== undefined) await showRoleSettings(roleSettings, context);
			continue;
		}
		await showWork(service, context, workId, actor);
	}
}

async function pickWork(
	work: readonly WorkSummary[],
	context: ExtensionContext,
	filter: string,
	keybindings: KhalaConfig["keybindings"],
): Promise<string | "help" | "filter" | "settings" | null> {
	const items: SelectItem[] = work.map((item) => ({
		value: item.workId,
		label: item.title,
		description: `Work  ${formatStatus(item.state)}  ${item.workId}${item.executionState === "blocked" ? "  blocked" : ""}`,
	}));
	const filtered = items.filter((item) =>
		`${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
	);
	return context.ui.custom<string | "filter" | "help" | "settings" | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Khala")), 1, 0));
		container.addChild(new Spacer(1));
		const list = new SelectList(filtered, Math.min(5, Math.max(1, filtered.length)), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: () =>
				theme.fg("warning", filter.length === 0 ? "  No Work has been submitted." : "  No Work matches the filter."),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`↑↓ navigate  ${keybindings.filter} filter  ${keybindings.roleSettings} role settings  enter select  escape/ctrl+c cancel`,
				),
				1,
				0,
			),
		);
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === keybindings.filter) {
					done("filter");
					return;
				}
				if (data === keybindings.help) {
					done("help");
					return;
				}
				if (data === keybindings.roleSettings) {
					done("settings");
					return;
				}
				if (matchesKey(data, "backspace")) {
					done(null);
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

const NAVIGATION_FOOTER = "↑↓ navigate  enter select  escape/ctrl+c cancel";
type WorkSection = "actions" | "evidence" | "history" | "blocking-signal";

async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
): Promise<"back"> {
	for (;;) {
		const work = await service.inspectRuntime(workId);
		const section = await pickSection(work, context);
		if (section === null || section === "back") return "back";
		if (section === "actions") {
			await chooseAction(service, context, work, actor);
			continue;
		}
		if (section === "evidence") {
			await showEvidence(work, context);
			continue;
		}
		if (section === "history") {
			await showHistory(service, context, work, actor);
			continue;
		}
		await showBlockingSignal(work, context);
	}
}

async function pickSection(work: WorkView, context: ExtensionContext): Promise<WorkSection | "back" | null> {
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		{ value: "history", label: "History" },
		...(work.execution?.state === "blocked" ? [{ value: "blocking-signal", label: "Inspect blocking signal" }] : []),
	];
	return context.ui.custom<WorkSection | "back" | null>((tui, theme, _keybindings, done) => {
		const mission = work.mission === undefined ? "not admitted" : formatStatus(work.missionState ?? "unknown");
		const execution = work.execution;
		const status = [
			`work       ${theme.bold(formatStatus(work.state))}`,
			`mission    ${mission}`,
			`execution  ${formatExecutionState(execution?.state ?? "not started")}`,
			`runtime    ${formatRuntimeState(execution)}`,
			`next       ${work.nextAction}`,
		];
		const summary = new Container();
		summary.addChild(new Text(theme.fg("accent", theme.bold(work.terms.title)), 1, 0));
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
		await showTextPage(context, "Actions", ["No actions are currently available."]);
		return;
	}
	const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Actions")), 1, 0));
		const list = new SelectList(
			actions.map((action) => ({ value: action.id, label: action.label })),
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
		await showTextPage(context, "Action failed", [result.error.summary, `remediation: ${result.error.remediation}`]);
		return;
	}
	schedulePendingEffects(service);
	await showTextPage(context, "Action complete", [`action: ${action.label}`, `next: ${result.value.nextAction}`]);
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
				work.state === "cancelled"
					? "Preparing this Work for a new attempt"
					: "Checking the Work and restoring its Executor",
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
				progress: `${formatStatus(progress.stage)}  ${progress.message}`,
				doing: "Khala is restoring the Work",
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
							doing: "Khala could not restore the Work",
							reason: "The recovery operation could not be completed",
							next:
								result.error.code === "revision-conflict"
									? "Action needed  Refresh the Work and try again"
									: "Action needed  Inspect Evidence for the failure details",
						});
						return;
					}
					schedulePendingEffects(service);
					const failed = result.value.state === "failed" || result.value.execution?.state === "failed";
					const awaitingReview = result.value.execution?.state === "awaiting-review";
					update(
						failed
							? {
									status: "failed",
									progress: "stopped",
									doing: "Khala could not restore the Work",
									reason: "The restored connection could not be confirmed",
									next: "Action needed  Inspect Evidence and decide what to do next",
								}
							: {
									status: "succeeded",
									progress: "complete",
									doing:
										work.state === "cancelled"
											? "Work returned to admission"
											: awaitingReview
												? "Work restored and waiting for review"
												: "Work restored and ready to continue",
									next:
										work.state === "cancelled"
											? "No action needed  Khala will continue admission automatically"
											: awaitingReview
												? "Action needed  Review the Work when the provider responds"
												: "No action needed  Khala will continue the Work automatically",
								},
					);
				})
				.catch(() =>
					update({
						status: "failed",
						progress: "stopped",
						doing: "Khala could not restore the Work",
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
	return value === "actions" || value === "evidence" || value === "history" || value === "blocking-signal";
}

function formatStatus(value: string): string {
	return value.replace(/-/g, " ");
}

function formatExecutionState(value: string): string {
	return value === "running" ? "active" : formatStatus(value);
}

function formatRuntimeState(execution: WorkView["execution"]): string {
	if (execution === undefined) return "unavailable";
	const runtime = execution.runtimeState ?? "unknown";
	if (execution.state !== "blocked") return formatStatus(runtime);
	if (runtime === "working") return "finishing current turn";
	if (runtime === "pending") return "awaiting Conclave";
	if (runtime === "idle") return "idle; awaiting Conclave";
	if (runtime === "unreachable") return "unreachable; awaiting Conclave";
	return "unknown; awaiting Conclave";
}

function formatActivity(execution: WorkView["execution"]): string {
	if (execution === undefined) return "none recorded";
	if (execution.state === "blocked") {
		return execution.runtimeState === "working" ? "executor turn finishing" : "awaiting Conclave assessment";
	}
	if (execution.runtimeState === "idle") return "executor turn completed";
	if (execution.runtimeState === "working") return "executor turn active";
	if (execution.runtimeState === "pending") return "executor turn pending";
	return "execution recorded";
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

async function showEvidence(work: WorkView, context: ExtensionContext): Promise<void> {
	const execution = work.execution;
	const signal = work.lastSignal;
	const signalEvidence = signal === undefined ? "none" : summarizeEvidence(signal.evidence);
	const signalLabel =
		signal === undefined
			? "none"
			: `${signal.kind === "blocked" ? "blocking signal" : "signal"} — ${compactText(signal.summary)}`;
	await showTextPage(context, "Evidence", [
		`state: ${formatStatus(work.state)}`,
		`mission: ${formatStatus(work.missionState ?? "not admitted")}`,
		`execution: ${formatExecutionState(execution?.state ?? "not started")}`,
		`runtime: ${formatRuntimeState(execution)}`,
		`activity: ${formatActivity(execution)}`,
		`signal: ${signalLabel}`,
		`signal evidence: ${signalEvidence}`,
		`provider observation: ${work.lastObservation?.summary ?? "none"}`,
		`review request: ${work.reviewRequest?.url ?? "none"}`,
		`review status: ${work.reviewRequest?.status ?? "none"}`,
		`error: ${work.lastError?.summary ?? "none"}`,
		`remediation: ${work.lastError?.remediation ?? "none"}`,
	]);
}

type RecordPage = Readonly<{ title: string; lines: readonly string[] }>;

function historyLabel(record: RecordView): string {
	if (record.kind !== "signal") return `#${record.sequence} ${formatStatus(record.kind)}`;
	const kind = readPayloadText(record.payload, "kind") ?? "signal";
	return `#${record.sequence} Signal · ${capitalize(kind)}`;
}

function formatRecordPage(record: RecordView): RecordPage {
	if (record.kind === "signal") {
		const kind = readPayloadText(record.payload, "kind") ?? "signal";
		const response = readPayloadText(record.payload, "summary") ?? record.summary;
		const evidence = readPayloadTextList(record.payload, "evidence") ?? record.evidenceRefs;
		return {
			title: `Signal · ${capitalize(kind)}`,
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
	if (record.kind === "oracle-review") {
		return formatOracleRecordPage(record);
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

function formatOracleRecordPage(record: RecordView): RecordPage {
	const verdict = readPayloadText(record.payload, "verdict") ?? "unknown";
	const findings = readPayloadObjects(record.payload, "findings");
	const validationGaps = readPayloadTextList(record.payload, "validationGaps") ?? [];
	const output = readPayloadText(record.payload, "output");
	return {
		title: `Oracle response · ${capitalize(verdict)}`,
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

function readPayloadText(payload: JsonValue, key: string): string | undefined {
	return isJsonObject(payload) ? readObjectText(payload, key) : undefined;
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

function compactText(value: string, limit = 180): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function summarizeEvidence(evidence: readonly string[]): string {
	if (evidence.length === 0) return "none";
	return `${evidence.length} evidence item${evidence.length === 1 ? "" : "s"}; open History for details`;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function isTextValue(value: JsonValue | undefined): value is string {
	return value !== undefined && value === String(value);
}

async function showHistory(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<void> {
	const records: RecordView[] = [];
	let cursor: string | undefined;
	try {
		do {
			const page = service.readRecords(
				{ workId: work.workId },
				{ actor, commandId: `tui:history:${work.workId}:${work.revision}`, schemaVersion: 1 },
				cursor,
			);
			records.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	} catch (error) {
		await showTextPage(context, "History", [
			`Unable to read history: ${error instanceof Error ? error.message : String(error)}`,
		]);
		return;
	}
	if (records.length === 0) {
		await showTextPage(context, "History", ["No Archive records are available for this Work."]);
		return;
	}
	for (;;) {
		const selected = await selectHistoryRecord(records, context);
		if (selected === null || selected === "back") return;
		const record = records.find((candidate) => String(candidate.sequence) === selected);
		if (record === undefined) return;
		const page = formatRecordPage(record);
		await showTextPage(context, page.title, page.lines);
	}
}

async function selectHistoryRecord(records: readonly RecordView[], context: ExtensionContext): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("History")), 1, 0));
		container.addChild(new Text(theme.fg("muted", `${records.length} Archive records`), 1, 0));
		const list = new SelectList(
			records.map((record) => ({ value: String(record.sequence), label: historyLabel(record) })),
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
		const confirmed = await context.ui.confirm("Cancel Work?", "This records an explicit cancelled Outcome.");
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
		"↑↓ navigate  / filter  ? help  r role settings  enter select  escape/ctrl+c cancel",
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
