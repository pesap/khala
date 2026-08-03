// biome-ignore-all lint/style/noTernary: Compact optional session row fields are intentionally explicit.
// biome-ignore-all lint/style/noExcessiveLinesPerFile: The existing monitor list and its selected detail stay one scannable surface.
import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type KhalaSession, KhalaSessionState, type KhalaSessionStateValue } from "./khala-sessions.js";

const COMMIT_ABBREVIATION_LENGTH = 12;
const SESSION_COLUMN_WIDTH = 20;
const MAX_VISIBLE_SESSION_ROWS = 4;
const NAME_LABEL_OVERHEAD = 3;
const MIN_WIDTH = 1;
const STATUS_PADDING_WIDTH = 2;
const CURSOR_WIDTH = 2;
const STATUS_COLUMN_RATIO = 0.45;

class KhalaSessionList implements Component {
	onSelectionChange?: (session: KhalaSession) => void;
	onSelect?: (session: KhalaSession) => void;
	onView?: (session: KhalaSession) => void;
	onCancel?: () => void;
	private sessions: readonly KhalaSession[];
	private readonly theme: Theme;
	private selectedIndex: number;

	private readonly keybindings: KeybindingsManager;

	constructor(sessions: readonly KhalaSession[], theme: Theme, keybindings: KeybindingsManager) {
		this.sessions = sessions;
		this.theme = theme;
		this.keybindings = keybindings;
		const currentIndex = sessions.findIndex((session) => session.isCurrent);
		this.selectedIndex = 0;
		if (currentIndex >= 0) {
			this.selectedIndex = currentIndex;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const startIndex = this.getVisibleStartIndex();
		const visibleSessions = this.sessions.slice(startIndex, startIndex + MAX_VISIBLE_SESSION_ROWS);
		lines.push(...visibleSessions.map((session) => this.renderSession(session, width)));
		const selected = this.getSelectedSession();
		if (selected?.executionMonitor !== undefined) {
			lines.push(...renderExecutionDetails(selected, width, this.theme));
		}
		if (visibleSessions.length < this.sessions.length) {
			const endIndex = startIndex + visibleSessions.length;
			lines.push(this.theme.fg("dim", `sessions ${startIndex + 1}-${endIndex}/${this.sessions.length}`));
		}
		return lines;
	}

	invalidate(): void {
		// Rows are rendered directly from the current selection and session records.
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			const session = this.getSelectedSession();
			if (session === undefined) {
				return;
			}
			if (session.displayOnly) {
				if (session.launcher !== undefined && session.target !== undefined) {
					this.onView?.(session);
				}
				return;
			}
			this.onSelect?.(session);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	getSelectedSession(): KhalaSession | undefined {
		return this.sessions[this.selectedIndex];
	}

	updateSessions(sessions: readonly KhalaSession[]): void {
		const selectedId = this.getSelectedSession()?.id;
		this.sessions = sessions;
		let selectedIndex = -1;
		if (selectedId !== undefined) {
			selectedIndex = sessions.findIndex((session) => session.id === selectedId);
		}
		if (selectedIndex < 0) {
			selectedIndex = sessions.findIndex((session) => session.isCurrent);
		}
		if (selectedIndex < 0) {
			selectedIndex = Math.min(this.selectedIndex, Math.max(0, sessions.length - 1));
		}
		this.selectedIndex = selectedIndex;
		const selectedSession = this.getSelectedSession();
		if (selectedSession !== undefined) {
			this.onSelectionChange?.(selectedSession);
		}
	}

	private moveSelection(delta: number): void {
		if (this.sessions.length === 0) {
			return;
		}
		this.selectedIndex = (this.selectedIndex + delta + this.sessions.length) % this.sessions.length;
		const session = this.getSelectedSession();
		if (session !== undefined) {
			this.onSelectionChange?.(session);
		}
	}

	private getVisibleStartIndex(): number {
		if (this.sessions.length <= MAX_VISIBLE_SESSION_ROWS) {
			return 0;
		}
		// Reserve vertical space for selected details and legends; the popup does not provide child height.
		const centeredStart = this.selectedIndex - Math.floor(MAX_VISIBLE_SESSION_ROWS / 2);
		const lastStart = this.sessions.length - MAX_VISIBLE_SESSION_ROWS;
		return Math.max(0, Math.min(centeredStart, lastStart));
	}

	private renderSession(session: KhalaSession, width: number): string {
		const isSelected = this.sessions[this.selectedIndex]?.id === session.id;
		let cursor = "  ";
		if (isSelected) {
			cursor = this.theme.fg("accent", "→ ");
		}
		const name = truncateToWidth(session.name, SESSION_COLUMN_WIDTH - NAME_LABEL_OVERHEAD, "…");
		const label = `${this.theme.fg(getRoleColor(session.role), "▌")} ${name}`;
		const labelWidth = visibleWidth(`▌ ${name}`);
		const labelSpacing = " ".repeat(Math.max(MIN_WIDTH, SESSION_COLUMN_WIDTH - labelWidth));
		const availableWidth = Math.max(MIN_WIDTH, width - CURSOR_WIDTH - SESSION_COLUMN_WIDTH - STATUS_PADDING_WIDTH);
		const statusWidth = Math.max(MIN_WIDTH, Math.floor(availableWidth * STATUS_COLUMN_RATIO));
		const taskWidth = Math.max(MIN_WIDTH, availableWidth - statusWidth);
		let activity = session.task;
		if (session.latestSignal !== undefined) {
			activity = `${activity} · ${session.latestSignal.kind} · ${session.latestSignal.summary}`;
		}
		const task = truncateToWidth(activity, taskWidth, "…");
		const taskSpacing = " ".repeat(Math.max(MIN_WIDTH, taskWidth - visibleWidth(task)));
		let statusText = `${session.stateLabel} · ${getSessionAction(session)}`;
		if (session.executionMonitor !== undefined) {
			statusText = `headless ${session.executionMonitor.runtimeState} · supervision ${session.executionMonitor.supervisionState}`;
		}
		const status = this.theme.fg(getSessionColor(session.state), truncateToWidth(statusText, statusWidth, ""));
		const line = `${cursor}${label}${labelSpacing}${task}${taskSpacing}${" ".repeat(STATUS_PADDING_WIDTH)}${status}`;
		const fittedLine = truncateToWidth(line, Math.max(MIN_WIDTH, width), "…");
		if (isSelected) {
			return this.theme.bg("selectedBg", this.theme.fg("text", fittedLine));
		}
		return fittedLine;
	}
}

function getSessionAction(session: KhalaSession): string {
	if (session.displayOnly) {
		if (session.launcher !== undefined && session.target !== undefined) {
			return "view pane";
		}
		return "display only";
	}
	if (session.isCurrent) {
		return "current session";
	}
	return session.action;
}

function renderRoleLegend(theme: Theme): string {
	return `${theme.fg("dim", "Role strip")}  ${theme.fg("muted", "▌ User")}  ${theme.fg("accent", "▌ Conclave")}  ${theme.fg("warning", "▌ Executor")}  ${theme.fg("mdLink", "▌ Observer")}  ${theme.fg("mdLink", "▌ Preserver")}`;
}

function renderStatusLegend(theme: Theme): string {
	return `${theme.fg("dim", "Status")}  ${theme.fg("warning", "Input Required")}  ${theme.fg("accent", "Review Ready")}  ${theme.fg("error", "Possibly Stalled / Failed")}  ${theme.fg("success", "Active")}`;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The selected Executor detail deliberately keeps all minimum UX facts together.
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: The selected detail is one bounded factual monitor surface.
function renderExecutionDetails(session: KhalaSession, width: number, theme: Theme): string[] {
	const monitor = session.executionMonitor;
	if (monitor === undefined) {
		return [];
	}
	let runtimeSuffix = "";
	if (monitor.incomplete) {
		runtimeSuffix = "; incomplete evidence";
	}
	const lines: string[] = [
		`Executor detail: ${session.identity}`,
		`Runtime: headless ${monitor.runtimeState}${runtimeSuffix}`,
		`Supervision: ${monitor.supervisionState}`,
		`Models: Conclave ${monitor.models.conclave}; Executor ${monitor.models.executor}`,
		`Limits: Conclave ${formatUsd(monitor.thresholds.conclaveUsd)}; Executor ${formatUsd(monitor.thresholds.executorUsd)}`,
		`Latest cost: Conclave ${formatCost(monitor.latestTurnCost.conclave)}; Executor ${formatCost(monitor.latestTurnCost.executor)}`,
	];
	if (monitor.upstream !== undefined) {
		const abbreviated = monitor.upstream.headCommit.slice(0, COMMIT_ABBREVIATION_LENGTH);
		lines.push(`Upstream Work: ${monitor.upstream.workId}; base ${abbreviated}`);
		let staleSuffix = "";
		if (monitor.upstream.stale) {
			staleSuffix = "; stale/invalidation";
		}
		lines.push(`Base evidence: ${monitor.upstream.headCommit}${staleSuffix}`);
	}
	if (monitor.latestSignificantAction !== undefined) {
		lines.push(`Action: ${monitor.latestSignificantAction.summary}`);
		lines.push(...monitor.latestSignificantAction.details.map((detail) => `Action evidence: ${detail}`));
	}
	if (monitor.steer !== undefined) {
		lines.push(
			`Steer: ${monitor.steer.status}; mode ${monitor.steer.mode}; category ${monitor.steer.category ?? "unavailable"}`,
		);
		lines.push(`Steer term: ${monitor.steer.missionTerm ?? "unavailable"}`);
		lines.push(`Steer message: ${monitor.steer.message ?? "unavailable"}`);
		lines.push(`Abort: ${monitor.steer.abort}; prompt: ${monitor.steer.prompt}`);
		if (monitor.steer.observedEntryIds.length > 0) {
			lines.push(`Observed Pi entries: ${monitor.steer.observedEntryIds.join(", ")}`);
		}
		if (monitor.steer.outcome !== undefined) {
			lines.push(
				`Intervention outcome: ${monitor.steer.outcome}; ${monitor.steer.outcomeReason ?? "reason unavailable"}`,
			);
		}
	}
	if (monitor.coordination !== undefined) {
		lines.push(`Coordination: ${monitor.coordination.relation}; priority ${monitor.coordination.selectedWorkId}`);
		lines.push(`Coordination reason: ${monitor.coordination.selectedReason}`);
		if (monitor.coordination.stoppedWorkId !== undefined) {
			lines.push(`Stopped Work: ${monitor.coordination.stoppedWorkId}`);
		}
		if (monitor.coordination.delayedWorkId !== undefined) {
			lines.push(`Delayed Work: ${monitor.coordination.delayedWorkId}`);
		}
		if (monitor.coordination.requiredUpstreamCommit !== undefined) {
			lines.push(`Required upstream commit: ${monitor.coordination.requiredUpstreamCommit}`);
		}
		if (monitor.coordination.invalidatedWorkIds.length > 0) {
			lines.push(`Invalidated Work: ${monitor.coordination.invalidatedWorkIds.join(", ")}`);
		}
		if (monitor.coordination.terminalSchedulingFailure) {
			lines.push("Coordination: terminal scheduling failure");
		}
		lines.push("Override by speaking in the Conclave session.");
	}
	if (monitor.grace !== undefined && monitor.supervisionState !== "connected") {
		lines.push(
			`Recovery: ${monitor.grace.kind}; failed checks ${monitor.grace.failedCheckCount}; deadline ${monitor.grace.deadlineAt}`,
		);
	}
	return lines.flatMap((line) => wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, width)));
}

function formatUsd(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value <= 0) {
		return "unavailable";
	}
	return `$${value}`;
}

function formatCost(cost: {
	costUsd?: number | undefined;
	thresholdUsd?: number | undefined;
	overrun: boolean;
}): string {
	const observed = formatUsd(cost.costUsd);
	const threshold = formatUsd(cost.thresholdUsd);
	let overrun = "";
	if (cost.overrun) {
		overrun = "; overrun, work continues";
	}
	return `${observed} / max ${threshold}${overrun}`;
}

function getRoleColor(role: string): ThemeColor {
	const normalizedRole = role.toLowerCase();
	if (normalizedRole === "conclave") {
		return "accent";
	}
	if (normalizedRole === "executor") {
		return "warning";
	}
	if (normalizedRole === "observer" || normalizedRole === "preserver") {
		return "mdLink";
	}
	return "muted";
}

function getSessionColor(state: KhalaSessionStateValue): ThemeColor {
	if (state === KhalaSessionState.input) {
		return "warning";
	}
	if (state === KhalaSessionState.review) {
		return "accent";
	}
	if (state === KhalaSessionState.stalled || state === KhalaSessionState.failed) {
		return "error";
	}
	return "success";
}

export {
	getRoleColor,
	getSessionAction,
	getSessionColor,
	KhalaSessionList,
	renderExecutionDetails,
	renderRoleLegend,
	renderStatusLegend,
};
