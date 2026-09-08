import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkSummary } from "./model.js";

function formatStatus(value: string): string {
	return value.replace(/-/g, " ");
}

const MAX_WORK_NAME_LENGTH = 36;
const WIDE_WORK_TABLE_COLUMNS = { title: 36, id: 10, state: 15, execution: 15, showId: true } as const;
type WorkTableLayout = Readonly<{
	title: number;
	id: number;
	state: number;
	execution: number;
	showId: boolean;
}>;
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

export function isHiddenWork(item: WorkSummary): boolean {
	return item.state === "succeeded" || (item.state === "stopped" && item.stopReason !== "failed");
}

export function truncateWorkName(value: string): string {
	const normalized = value.replace(/[\r\n]+/g, " ").trim();
	return normalized.length <= MAX_WORK_NAME_LENGTH ? normalized : normalized.slice(0, MAX_WORK_NAME_LENGTH).trimEnd();
}

export function tableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function selectionMarker(selected: boolean): string {
	return selected ? "→ " : "  ";
}
export function workTableLayout(width: number): WorkTableLayout {
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

export function hasWorkFailure(item: WorkSummary): boolean {
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

export function workTableHeader(theme: Theme, layout: WorkTableLayout): string {
	const id = layout.showId ? `  ${tableCell("ID", layout.id)}` : "";
	return theme.fg(
		"dim",
		`  ${tableCell("TITLE", layout.title)}${id}  ${tableCell("STATE", layout.state)}  ${tableCell("EXECUTION", layout.execution)}`,
	);
}

function shortId(value: string): string {
	return value.length <= 10 ? value : value.slice(0, 10);
}

export function workTableRow(theme: Theme, item: WorkSummary, selected: boolean, layout: WorkTableLayout): string {
	const title = tableCell(truncateWorkName(item.title), layout.title);
	const id = layout.showId ? `  ${tableCell(shortId(item.workId), layout.id)}` : "";
	const state = workState(item);
	const execution = executionState(item);
	const row = `${title}${id}  ${WORK_STATUS_PALETTE[state.tone](theme, tableCell(state.label, layout.state))}  ${WORK_STATUS_PALETTE[execution.tone](theme, tableCell(execution.label, layout.execution))}`;
	const indented = `${selectionMarker(selected)}${row}`;
	return selected ? theme.fg("accent", theme.bold(indented)) : indented;
}
