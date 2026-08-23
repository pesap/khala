import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { KhalaConfig } from "./config.js";
import type { Action, Actor, JsonObject, WorkSummary, WorkView } from "./model.js";
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
		const result = await showWork(service, context, workId, actor);
		if (result === "refresh") {
			continue;
		}
		if (result === "filter") {
			filter = (await context.ui.input("Filter Work by title or ID:", filter)) ?? filter;
			continue;
		}
		return;
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
		label: `${item.title} — ${item.state}`,
		description: `${item.workId} · ${item.nextAction}${item.queuePosition === undefined ? "" : ` · queue ${item.queuePosition}`}`,
	}));
	items.push({ value: "help", label: "Help", description: "Keyboard and navigation help" });
	if (items.length === 1) {
		context.ui.notify("No Work matches the current filter.", "info");
	}
	return context.ui.custom<string | "filter" | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Khala Work")), 1, 0));
		container.addChild(new Text(theme.fg("muted", filter.length === 0 ? "Select Work" : `Filter: ${filter}`), 1, 0));
		const list = new SelectList(items, Math.min(10, Math.max(1, items.length)), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(
			new Text(
				theme.fg("dim", `${keybindings.filter} filter · ${keybindings.help} help · enter open · esc back`),
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
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
): Promise<"refresh" | "filter" | "back"> {
	for (;;) {
		const work = service.inspectWork(workId);
		const section = await pickSection(work, context);
		if (section === null || section === "back") {
			return "back";
		}
		if (section === "Overview") {
			context.ui.notify(renderOverview(work), "info");
			continue;
		}
		if (section === "Evidence") {
			context.ui.notify(renderEvidence(work), "info");
			continue;
		}
		if (section === "History") {
			context.ui.notify(renderHistory(work), "info");
			continue;
		}
		const actionResult = await chooseAction(service, context, work, actor);
		if (actionResult === "refresh") {
			continue;
		}
		if (actionResult === "filter") {
			return "filter";
		}
		if (actionResult === "back") {
			return "back";
		}
	}
}

async function pickSection(work: WorkView, context: ExtensionContext): Promise<string | "back" | null> {
	const items: SelectItem[] = [
		{ value: "Overview", label: "Overview", description: `${work.state} · revision ${work.revision}` },
		{ value: "Actions", label: "Actions", description: work.nextAction },
		{ value: "Evidence", label: "Evidence", description: "Bounded Signals and provider observations" },
		{ value: "History", label: "History", description: "Append-ordered Archive records" },
		{ value: "back", label: "Back", description: "Return to Work list" },
	];
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold(work.terms.title)), 1, 0));
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done("back");
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "up/down move · enter open · esc back"), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function chooseAction(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<"refresh" | "filter" | "back"> {
	const actions = service.availableActions(work.workId, actor, work.revision);
	const items: SelectItem[] = actions.map((action) => ({
		value: action.id,
		label: action.enabled ? action.label : `${action.label} [unavailable]`,
		description: action.enabled ? "Ready" : (action.disabledReason ?? "Unavailable"),
	}));
	items.push({ value: "back", label: "Back", description: "Return to sections" });
	const selected = await context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Actions")), 1, 0));
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done("back");
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Unavailable actions remain visible with their reason."), 1, 0));
		container.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (selected === null || selected === "back") {
		return "back";
	}
	const action = actions.find((candidate) => candidate.id === selected);
	if (action === undefined || !action.enabled) {
		context.ui.notify(action?.disabledReason ?? "Action is unavailable.", "warning");
		return "refresh";
	}
	const input = await actionInput(action, context);
	if (input === null) {
		return "refresh";
	}
	const result = await service.perform({
		action: action.kind,
		workId: work.workId,
		input,
		meta: { commandId: `tui:${action.id}`, actor, expectedWorkRevision: work.revision, schemaVersion: 1 },
	});
	if ("error" in result) {
		context.ui.notify(`${result.error.summary} ${result.error.remediation}`, "error");
	} else {
		context.ui.notify(result.value.nextAction, "info");
	}
	return "refresh";
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
	context.ui.notify(
		"Up/Down move · Enter open or confirm · Esc back or cancel · configured filter/help keys. Navigation never writes Archive state.",
		"info",
	);
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

function renderOverview(work: WorkView): string {
	return [
		`Overview · ${work.terms.title}`,
		`State: ${work.state}`,
		`Revision: ${work.revision}`,
		`Budget: ${work.budget.reservedTokens}/${work.budget.maxTokens} reserved; ${work.budget.consumedTokens} consumed`,
		`Mission: ${work.mission?.missionId ?? "not admitted"}`,
		`Execution: ${work.execution?.executionId ?? "not started"}`,
		`Next action: ${work.nextAction}`,
	].join("\n");
}

function renderEvidence(work: WorkView): string {
	return [
		"Evidence",
		work.lastSignal === undefined ? "Signal: none" : `Signal: ${work.lastSignal.kind} — ${work.lastSignal.summary}`,
		work.lastSignal === undefined ? "Signal evidence: none" : `Signal evidence: ${work.lastSignal.evidence.join("; ")}`,
		work.lastObservation === undefined
			? "Provider observation: none"
			: `Provider observation: ${work.lastObservation.summary}`,
		work.reviewRequest === undefined
			? "Review request: none"
			: `Review request: ${work.reviewRequest.url} (${work.reviewRequest.status})`,
	].join("\n");
}

function renderHistory(work: WorkView): string {
	return [
		"History",
		`Work ID: ${work.workId}`,
		`Current revision: ${work.revision}`,
		"Use khala_read_archive for append-ordered bounded records.",
	].join("\n");
}
