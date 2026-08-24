import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
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
import type { Action, Actor, JsonObject, RecordView, RecoveryUpdate, WorkSummary, WorkView } from "./model.js";
import type { ApplicationService } from "./service.js";

export async function showKhala(
	service: ApplicationService,
	context: ExtensionContext,
	actor: Actor = "user",
	keybindings: KhalaConfig["keybindings"] = { filter: "/", help: "?" },
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
		await showWork(service, context, workId, actor);
	}
}

async function pickWork(
	work: readonly WorkSummary[],
	context: ExtensionContext,
	filter: string,
	keybindings: KhalaConfig["keybindings"],
): Promise<string | "help" | "filter" | null> {
	const filtered = work.filter((item) =>
		`${item.workId} ${item.title} ${item.state}`.toLowerCase().includes(filter.toLowerCase()),
	);
	const items: SelectItem[] = filtered.map((item) => ({
		value: item.workId,
		label: item.title,
		description: `Work  ${formatStatus(item.state)}  ${item.workId}`,
	}));
	return context.ui.custom<string | "filter" | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("khala works:")), 1, 0));
		container.addChild(new Text(theme.fg("muted", "Work rows  admission creates a Mission"), 1, 0));
		container.addChild(new Spacer(1));
		const list = new SelectList(items, Math.min(5, Math.max(1, items.length)), {
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
			new Text(theme.fg("dim", `↑↓ navigate  ${keybindings.filter} filter enter select  escape/ctrl+c cancel`), 1, 0),
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
type WorkSection = "actions" | "evidence" | "history";

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
		await showHistory(service, context, work, actor);
	}
}

async function pickSection(work: WorkView, context: ExtensionContext): Promise<WorkSection | "back" | null> {
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		{ value: "history", label: "History" },
	];
	return context.ui.custom<WorkSection | "back" | null>((tui, theme, _keybindings, done) => {
		const mission = work.mission === undefined ? "not admitted" : formatStatus(work.missionState ?? "unknown");
		const execution = work.execution;
		const executionStatus =
			execution === undefined
				? "not started  now unavailable"
				: `${formatExecutionState(execution.state)}  now ${formatStatus(execution.runtimeState ?? "unknown")}`;
		const status = [
			`work       ${theme.bold(formatStatus(work.state))}  mission ${mission}`,
			`execution  ${executionStatus}`,
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
	return value === "actions" || value === "evidence" || value === "history";
}

function formatStatus(value: string): string {
	return value.replace(/-/g, " ");
}

function formatExecutionState(value: string): string {
	return value === "running" ? "active" : formatStatus(value);
}

async function showEvidence(work: WorkView, context: ExtensionContext): Promise<void> {
	const execution = work.execution;
	const activity =
		execution?.runtimeState === "idle"
			? "executor turn completed"
			: execution?.runtimeState === "working"
				? "executor turn active"
				: execution?.runtimeState === "pending"
					? "executor turn pending"
					: execution === undefined
						? "none recorded"
						: "execution recorded";
	await showTextPage(context, "Evidence", [
		`state: ${formatStatus(work.state)}  mission: ${formatStatus(work.missionState ?? "not admitted")}`,
		`execution: ${formatExecutionState(execution?.state ?? "not started")}  runtime: ${execution === undefined ? "unavailable" : formatStatus(execution.runtimeState ?? "unknown")}`,
		`activity: ${activity}`,
		`signal: ${work.lastSignal === undefined ? "none" : `${work.lastSignal.kind}: ${work.lastSignal.summary}`}`,
		`signal evidence: ${work.lastSignal?.evidence.join(", ") ?? "none"}`,
		`provider observation: ${work.lastObservation?.summary ?? "none"}`,
		`review request: ${work.reviewRequest?.url ?? "none"}`,
		`review status: ${work.reviewRequest?.status ?? "none"}`,
	]);
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
		await showTextPage(context, `Record ${record.sequence}: ${record.kind}`, [
			`actor: ${record.actor}`,
			`recorded: ${record.recordedAt}`,
			`summary: ${record.summary}`,
			`evidence: ${record.evidenceRefs.join(", ") || "none"}`,
		]);
	}
}

async function selectHistoryRecord(records: readonly RecordView[], context: ExtensionContext): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("History")), 1, 0));
		container.addChild(new Text(theme.fg("muted", `${records.length} Archive records`), 1, 0));
		const list = new SelectList(
			records.map((record) => ({ value: String(record.sequence), label: `#${record.sequence} ${record.kind}` })),
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
		"↑↓ navigate  / filter  ? help  enter select  escape/ctrl+c cancel",
	]);
}

function renderDashboard(work: readonly WorkSummary[]): string {
	if (work.length === 0) {
		return "Khala: no Work has been submitted.";
	}
	return [
		"Khala Work",
		...work.map((item) => `${item.state.padEnd(16)} ${item.title} (${item.workId}) — ${item.nextAction}`),
	].join("\n");
}
