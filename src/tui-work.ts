import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	parseKey,
	ScrollView,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { KhalaArchiveView } from "./archive-view.js";
import type { KhalaConfig } from "./config.js";
import type { Action, Actor, RecoveryUpdate, WorkView } from "./model.js";
import type { ApplicationService } from "./service.js";
import type { ActionRunner } from "./tui-actions.js";
import { showArchive, showEvidence } from "./tui-archive.js";
import { hasCurrentBlockedSignal, showBlockingSignal, showPeerReview } from "./tui-evidence.js";
import {
	addHeading,
	addKeyValueRows,
	addPanelKeybindings,
	formatFieldRows,
	isPanelBack,
	NAVIGATION_FOOTER,
	PANEL_BACK_FOOTER,
	presentEvidenceText,
	scrollPage,
	selectableComponent,
	selectorTheme,
	showPage,
	showTextPage,
} from "./tui-pages.js";
import { formatErrorSections } from "./tui-record-detail.js";
import { truncateWorkName } from "./tui-work-table.js";

type WorkSection = "actions" | "evidence" | "peer-review" | "archive" | "blocking-signal" | "refresh";
type WorkSelection = Readonly<{ kind: "section"; section: WorkSection }> | Readonly<{ kind: "action"; action: Action }>;
export async function showWork(
	service: ApplicationService,
	context: ExtensionContext,
	workId: string,
	actor: Actor,
	keybindings: KhalaConfig["keybindings"],
	runAction: ActionRunner,
): Promise<"back"> {
	let refreshed: WorkView | undefined;
	for (;;) {
		const saved = service.inspectWork(workId);
		const work = currentWorkSnapshot(saved, refreshed);
		const section = await pickSection(work, context, keybindings, availableWorkActions(service, work, actor));
		if (section === null) return "back";
		refreshed = await showWorkSection(section, service, context, work, actor, runAction);
	}
}

function currentWorkSnapshot(saved: WorkView, refreshed: WorkView | undefined): WorkView {
	return refreshed?.revision === saved.revision ? refreshed : saved;
}

export async function showArchiveWork(
	archive: KhalaArchiveView,
	context: ExtensionContext,
	workId: string,
): Promise<void> {
	const work = archive.inspectWork(workId);
	await showTextPage(context, truncateWorkName(work.terms.title), formatFieldRows(workSectionRows(work, undefined)));
}

async function showWorkSection(
	selection: WorkSelection,
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	runAction: ActionRunner,
): Promise<WorkView | undefined> {
	if (selection.kind === "action") {
		await applySelectedAction(service, context, work, actor, selection.action, runAction);
		return;
	}
	const handlers = {
		actions: () => chooseAction(service, context, work, actor, runAction),
		evidence: () => showEvidence(service, work, context, actor),
		archive: () => showArchive(service, context, work, actor),
		"peer-review": () => showPeerReview(work, context),
		"blocking-signal": () => showBlockingSignal(work, context),
		refresh: () => showRuntimeRefresh(service, context, work, actor),
	} satisfies Record<WorkSection, () => Promise<void | WorkView>>;
	return (await handlers[selection.section]()) ?? work;
}

async function pickSection(
	work: WorkView,
	context: ExtensionContext,
	keybindings: KhalaConfig["keybindings"],
	actions: readonly Action[],
): Promise<WorkSelection | null> {
	const choices = new Map<string, WorkSelection>([
		...WORK_SECTIONS.map((section) => [section, { kind: "section", section }] as const),
		...actions.map((action) => [`action:${action.id}`, { kind: "action", action }] as const),
	]);
	const hasReview = work.reviewRequest !== undefined || work.providerOutcome !== undefined;
	const items: SelectItem[] = [
		{ value: "actions", label: "Actions" },
		{ value: "evidence", label: "Evidence" },
		...(hasReview ? [{ value: "peer-review", label: "Peer-Review" }] : []),
		{ value: "archive", label: "Archive" },
		...(hasCurrentBlockedSignal(work) ? [{ value: "blocking-signal", label: "Inspect blocking signal" }] : []),
		{ value: "refresh", label: "Refresh runtime" },
		...actions.map((action) => ({ value: `action:${action.id}`, label: displayActionLabel(action) })),
	];
	return context.ui.custom<WorkSelection | null>((tui, theme, _keybindings, done) => {
		const rows = workSectionRows(work, undefined);
		const list = new SelectList(items, 4, selectorTheme(theme));
		list.onSelect = (item) => done(choices.get(item.value) ?? null);
		list.onCancel = () => done(null);
		const container = new Container();
		addHeading(container, theme, truncateWorkName(work.terms.title));
		container.addChild(new Spacer(1));
		addKeyValueRows(container, theme, rows);
		const scroll = new ScrollView(container, { overscroll: "contain", scrollbar: "auto" });
		const controls = new Container();
		controls.addChild(list);
		const footer = !hasReview ? NAVIGATION_FOOTER : `${NAVIGATION_FOOTER}  ${keybindings.comments} peer-review`;
		addPanelKeybindings(controls, theme, `escape back  pgup/pgdn details  ${footer}`);
		return selectableComponent(
			new VStack([scroll, { component: controls, shrink: 0 }]),
			list,
			tui,
			() => done(null),
			(data) => {
				if (isDetailScroll(data)) return scrollPage(scroll, data);
				if (!hasReview || parseKey(data) !== keybindings.comments) return false;
				done({ kind: "section", section: "peer-review" });
				return true;
			},
		);
	});
}

function isDetailScroll(data: string): boolean {
	const bindings = getKeybindings();
	return bindings.matches(data, "tui.editor.pageUp") || bindings.matches(data, "tui.editor.pageDown");
}

function workSectionRows(work: WorkView, archiveError: string | undefined): readonly (readonly [string, string])[] {
	return [
		["Work", formatWorkState(work)],
		["Goal", work.terms.objective],
		...workErrorRow(work),
		...(hasCurrentBlockedSignal(work) ? [["Blocker", work.lastSignal?.summary ?? ""] as const] : []),
		...nextActionRow(work),
		["Freshness", `Saved revision ${work.revision}; Refresh runtime for a live check`],
		...missionRow(work),
		...archiveErrorRow(archiveError),
		...executionRows(work.execution),
		...reviewRequestRow(work),
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
	runAction: ActionRunner,
): Promise<void> {
	if (action.kind === "recover") {
		await showRecovery(service, context, work, actor, action);
		return;
	}
	await runAction(work, action);
}

async function chooseAction(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	runAction: ActionRunner,
): Promise<void> {
	const current = currentWorkSnapshot(service.inspectWork(work.workId), work);
	const actions = availableWorkActions(service, current, actor);
	if (actions.length === 0) {
		await showTextPage(context, "Actions", ["No actions are currently available."]);
		return;
	}
	await runSelectedAction(actions, service, context, current, actor, runAction);
}

function availableWorkActions(service: ApplicationService, work: WorkView, actor: Actor): readonly Action[] {
	return service
		.availableActions(work.workId, actor, work.revision, work.execution?.runtimeState)
		.filter((action) => action.enabled);
}

async function runSelectedAction(
	actions: readonly Action[],
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	runAction: ActionRunner,
): Promise<void> {
	const selected = await selectAction(actions, context);
	if (selected === null || selected === "back") return;
	const action = actions.find((candidate) => candidate.id === selected);
	if (action === undefined) return;
	await applySelectedAction(service, context, work, actor, action, runAction);
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
		"reconcile-invocation": "Reconcile held usage",
		"fail-work": "Fail",
	} satisfies Partial<Record<Action["kind"], string>>;
	return labels[action.kind] ?? action.label;
}

function schedulePendingEffects(service: ApplicationService): void {
	queueMicrotask(() => void service.processPendingEffects().catch(() => undefined));
}

export type RecoveryDisplay = Readonly<{
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
	if (result.value.preparation?.status === "waiting")
		return {
			status: "failed",
			progress: "stopped",
			doing: "Executor preparation is still blocked",
			reason: presentEvidenceText(result.value.preparation.diagnostic),
			next: "Correct the prerequisite, then retry Recover from Actions.",
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

const pendingRecoveries = new WeakMap<ApplicationService, Set<string>>();

async function showRecovery(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	action: Action,
): Promise<void> {
	const pending = pendingRecoveries.get(service) ?? new Set<string>();
	pendingRecoveries.set(service, pending);
	if (pending.has(work.workId)) {
		context.ui.notify("Recovery is already in progress. Leaving the panel does not cancel it.", "info");
		return;
	}
	pending.add(work.workId);
	await context.ui.custom<void>((tui, theme, _keybindings, done) => {
		let closed = false;
		let display: RecoveryDisplay = {
			status: "in progress",
			progress: "checking runtime",
			doing:
				work.state === "stopped" && work.stopReason === "cancelled"
					? "Preparing a new attempt."
					: "Khala is checking and restoring the Executor.",
			next: "Escape returns to Work; recovery continues in the background.",
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
				next: "Escape returns to Work; recovery continues in the background.",
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
				})
				.finally(() => pending.delete(work.workId));
		});
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (isPanelBack(data)) {
					closed = true;
					done();
				}
			},
		};
	});
}

const WORK_SECTIONS: readonly WorkSection[] = [
	"actions",
	"evidence",
	"archive",
	"peer-review",
	"blocking-signal",
	"refresh",
];

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

async function showRuntimeRefresh(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<WorkView | undefined> {
	const result = await context.ui.custom<WorkView | Error | null>((tui, theme, _keys, done) => {
		const loader = new BorderedLoader(tui, theme, "Checking runtime; Escape stops waiting");
		let dismissed = false;
		loader.onAbort = () => {
			dismissed = true;
			done(null);
		};
		void service
			.inspectRuntime(
				work.workId,
				{
					actor,
					commandId: `tui:inspect:${work.workId}:${work.revision}`,
					expectedWorkRevision: work.revision,
					schemaVersion: 1,
				},
				{ signal: loader.signal },
			)
			.then((value) => {
				if (!dismissed) done(value);
			})
			.catch((error) => {
				if (!dismissed) done(error instanceof Error ? error : new Error(String(error)));
			});
		return loader;
	});
	if (result === null) return;
	if (result instanceof Error) {
		await showPage(
			context,
			"Runtime unavailable",
			formatErrorSections({
				code: "external-failure",
				summary: result.message,
				retryable: true,
				remediation: "Saved Work remains available; retry the explicit runtime check.",
				evidenceRefs: [],
			}),
		);
		return;
	}
	await showTextPage(context, "Runtime checked", formatFieldRows(workSectionRows(result, undefined)));
	return result;
}

export function recoveryDisplayRows(display: RecoveryDisplay): readonly (readonly [string, string])[] {
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
