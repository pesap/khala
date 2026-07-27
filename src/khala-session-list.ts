import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type KhalaSession, KhalaSessionState, type KhalaSessionStateValue } from "./khala-sessions.js";

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

	constructor(sessions: readonly KhalaSession[], theme: Theme) {
		this.sessions = sessions;
		this.theme = theme;
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
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (keybindings.matches(data, "tui.select.confirm")) {
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
		} else if (keybindings.matches(data, "tui.select.cancel")) {
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
		const statusText = `${session.stateLabel} · ${getSessionAction(session)}`;
		const status = this.theme.fg(getSessionColor(session.state), truncateToWidth(statusText, statusWidth, ""));
		const line = `${cursor}${label}${labelSpacing}${task}${taskSpacing}${" ".repeat(STATUS_PADDING_WIDTH)}${status}`;
		if (isSelected) {
			return this.theme.bg("selectedBg", this.theme.fg("text", line));
		}
		return line;
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
	return `${theme.fg("dim", "Role strip")}  ${theme.fg("muted", "▌ User")}  ${theme.fg("accent", "▌ Conclave")}  ${theme.fg("warning", "▌ Executioner")}  ${theme.fg("mdLink", "▌ Observer")}  ${theme.fg("mdLink", "▌ Preserver")}`;
}

function renderStatusLegend(theme: Theme): string {
	return `${theme.fg("dim", "Status")}  ${theme.fg("warning", "Input Required")}  ${theme.fg("accent", "Review Ready")}  ${theme.fg("error", "Possibly Stalled / Failed")}  ${theme.fg("success", "Active")}`;
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

export { getRoleColor, getSessionAction, getSessionColor, KhalaSessionList, renderRoleLegend, renderStatusLegend };
