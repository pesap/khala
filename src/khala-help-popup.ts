import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Box, type Component, matchesKey, Text } from "@earendil-works/pi-tui";
import { KHALA_HELP_KEY, KHALA_TOGGLE_SHORTCUT } from "./khala-keybindings.js";
import { renderRoleLegend, renderStatusLegend } from "./khala-session-list.js";

type KhalaHelpPopupOptions = Readonly<{
	theme: Theme;
	close: () => void;
	closeAll: () => void;
}>;

class KhalaHelpPopup implements Component {
	private readonly container: Box;
	private readonly close: () => void;
	private readonly closeAll: () => void;

	constructor(options: KhalaHelpPopupOptions) {
		const { theme, close, closeAll } = options;
		this.close = close;
		this.closeAll = closeAll;
		this.container = new Box(1, 1, (line: string) => theme.bg("toolPendingBg", line));
		this.container.addChild(new DynamicBorder((line: string) => theme.fg("borderAccent", line)));
		this.container.addChild(new Text(theme.fg("accent", theme.bold("KHALA HELP")), 1, 0));
		this.container.addChild(new Text(theme.fg("muted", "Navigation"), 1, 0));
		this.container.addChild(
			new Text("↑↓  select session\nenter  switch context or view Executor\nesc  close help\n?  close help", 1, 0),
		);
		this.container.addChild(new Text(theme.fg("muted", "Session roles"), 1, 0));
		this.container.addChild(new Text(renderRoleLegend(theme), 1, 0));
		this.container.addChild(new Text(theme.fg("muted", "Session status"), 1, 0));
		this.container.addChild(new Text(renderStatusLegend(theme), 1, 0));
		this.container.addChild(new Text(theme.fg("dim", "ctrl+i  close Khala"), 1, 0));
		this.container.addChild(new DynamicBorder((line: string) => theme.fg("borderAccent", line)));
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	invalidate(): void {
		this.container.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, KHALA_TOGGLE_SHORTCUT)) {
			this.closeAll();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, KHALA_HELP_KEY)) {
			this.close();
		}
	}
}

export { KhalaHelpPopup, type KhalaHelpPopupOptions };
