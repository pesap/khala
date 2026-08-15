import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, type Component, matchesKey, type OverlayHandle, Text, type TUI } from "@earendil-works/pi-tui";
import { KhalaHelpPopup } from "./khala-help-popup.js";
import { KHALA_HELP_KEY, KHALA_TOGGLE_SHORTCUT } from "./khala-keybindings.js";
import { KhalaSessionList } from "./khala-session-list.js";
import type { KhalaSession, KhalaSessionSource } from "./khala-sessions.js";

const SESSION_REFRESH_INTERVAL_MS = 1000;
const HELP_POPUP_OPTIONS = {
	anchor: "center" as const,
	width: "78%" as const,
	minWidth: 64,
	maxHeight: "100%" as const,
	margin: 0,
};

interface KhalaPopupOptions {
	sessions: readonly KhalaSession[];
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	close: () => void;
	onSwitch?: (session: KhalaSession) => void;
	onView?: (session: KhalaSession) => void;
}

class KhalaPopup implements Component {
	private readonly container: Box;
	private readonly sessionList: KhalaSessionList;
	private sessions: readonly KhalaSession[];
	private readonly summary: Text;
	private readonly canSwitch: boolean;
	private readonly tui: TUI;
	private readonly close: () => void;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private helpOverlay: OverlayHandle | undefined;

	constructor(opts: KhalaPopupOptions) {
		const { sessions, tui, theme, keybindings, close, onSwitch, onView } = opts;
		this.theme = theme;
		this.keybindings = keybindings;
		this.container = new Box(1, 1, (line: string) => theme.bg("toolPendingBg", line));
		this.tui = tui;
		this.close = close;
		this.sessions = sessions;
		this.sessionList = new KhalaSessionList(sessions, theme, keybindings);
		this.summary = new Text("", 1, 0);
		this.canSwitch = onSwitch !== undefined;
		this.updateSummary(sessions.length);
		this.configureSelection(onSwitch, onView);
		this.buildLayout();
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}

	refresh(sessions: readonly KhalaSession[]): void {
		if (sessions === this.sessions) {
			return;
		}
		this.sessions = sessions;
		this.sessionList.updateSessions(sessions);
		this.updateSummary(sessions.length);
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, KHALA_TOGGLE_SHORTCUT)) {
			this.close();
			return;
		}
		if (matchesKey(data, KHALA_HELP_KEY)) {
			this.showHelp();
			return;
		}
		this.sessionList.handleInput(data);
		this.tui.requestRender();
	}

	closeHelp(): void {
		this.helpOverlay?.hide();
		this.helpOverlay = undefined;
	}

	private showHelp(): void {
		if (this.helpOverlay !== undefined) {
			this.helpOverlay.focus();
			return;
		}
		const help = new KhalaHelpPopup({
			theme: this.theme,
			close: () => {
				this.closeHelp();
				this.tui.requestRender();
			},
			closeAll: this.close,
		});
		this.helpOverlay = this.tui.showOverlay(help, HELP_POPUP_OPTIONS);
	}

	private buildLayout(): void {
		const { theme } = this;
		this.container.addChild(new DynamicBorder((line: string) => theme.fg("borderAccent", line)));
		this.container.addChild(
			new Text(`${theme.fg("accent", theme.bold("KHALA"))}  ${theme.fg("dim", "SESSION CHANGER")}`, 1, 0),
		);
		this.container.addChild(this.summary);
		this.container.addChild(this.sessionList);
		const up = this.keybindings.getKeys("tui.select.up").join("/") || "unbound";
		const down = this.keybindings.getKeys("tui.select.down").join("/") || "unbound";
		const confirm = this.keybindings.getKeys("tui.select.confirm").join("/") || "unbound";
		const cancel = this.keybindings.getKeys("tui.select.cancel").join("/") || "unbound";
		this.container.addChild(
			new Text(
				theme.fg(
					"dim",
					`${up}/${down} select  ·  ${confirm} switch/view  ·  ${KHALA_HELP_KEY} help  ·  ${cancel} / ${KHALA_TOGGLE_SHORTCUT} close`,
				),
				1,
				0,
			),
		);
		this.container.addChild(new DynamicBorder((line: string) => theme.fg("borderAccent", line)));
	}

	private updateSummary(sessionCount: number): void {
		let hint = "";
		if (this.canSwitch) {
			const confirm = this.keybindings.getKeys("tui.select.confirm").join("/") || "unbound";
			hint = ` · ${confirm} to switch context`;
		}
		this.summary.setText(this.theme.fg("dim", `${sessionCount} sessions${hint}`));
	}

	private configureSelection(
		onSwitch?: (session: KhalaSession) => void,
		onView?: (session: KhalaSession) => void,
	): void {
		if (onSwitch !== undefined) {
			this.sessionList.onSelect = (session) => {
				if (!session.displayOnly && session.sessionPath.length > 0) {
					onSwitch(session);
				}
			};
		}
		if (onView !== undefined) {
			this.sessionList.onView = (session) => {
				if (session.launcher !== undefined && session.target !== undefined) {
					this.close();
					onView(session);
				}
			};
		}
		this.sessionList.onCancel = this.close;
	}
}

let closePopup: (() => void) | undefined;

async function toggleKhalaPopup(
	context: ExtensionContext,
	source: KhalaSessionSource,
	onSwitch?: (sessionPath: string) => void,
	onView?: (session: KhalaSession) => void,
): Promise<void> {
	if (closePopup !== undefined) {
		closePopup();
		return;
	}
	if (context.mode !== "tui") {
		context.ui.notify("The Khala popup is only available in Pi's interactive mode.", "warning");
		return;
	}

	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	try {
		await context.ui.custom<null>((tui, theme, keybindings, done) => {
			let popup: KhalaPopup | undefined;
			const close = () => {
				popup?.closeHelp();
				if (refreshTimer !== undefined) {
					clearInterval(refreshTimer);
					refreshTimer = undefined;
				}
				closePopup = undefined;
				done(null);
			};
			closePopup = close;
			const handleSwitch = (session: KhalaSession) => {
				if (onSwitch !== undefined && session.sessionPath.length > 0) {
					close();
					onSwitch(session.sessionPath);
				}
			};
			const readSessions = () => source.getActiveSessions(context.sessionManager.getSessionFile() ?? "");
			const popupOptions: KhalaPopupOptions = {
				sessions: readSessions(),
				tui,
				theme,
				keybindings,
				close,
				onSwitch: handleSwitch,
			};
			if (onView !== undefined) {
				popupOptions.onView = onView;
			}
			popup = new KhalaPopup(popupOptions);
			refreshTimer = setInterval(() => {
				try {
					popup?.refresh(readSessions());
				} catch {
					// Do not let a transient refresh failure close or crash the popup.
				}
			}, SESSION_REFRESH_INTERVAL_MS);
			return popup;
		});
	} finally {
		if (refreshTimer !== undefined) {
			clearInterval(refreshTimer);
		}

		closePopup = undefined;
	}
}

export { toggleKhalaPopup };
