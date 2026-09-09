import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	type Keybinding,
	matchesKey,
	ScrollView,
	type SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	truncateToWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RecordView } from "./model.js";

export type PageSection = Readonly<{ heading?: string; lines: readonly string[] }>;
export type RecordPage = Readonly<{ title: string; sections: readonly PageSection[] }>;

export function pageSection(lines: readonly string[], heading?: string): PageSection {
	return heading === undefined ? { lines } : { heading, lines };
}

export function optionalPageSection(lines: readonly string[], heading?: string): readonly PageSection[] {
	return lines.length === 0 ? [] : [pageSection(lines, heading)];
}

export type RecordListMode = "evidence" | "archive";
export type RecordListEntry = Readonly<{ kind: "record"; record: RecordView }>;
export function presentEvidenceText(value: string): string {
	return value.trim();
}

export async function showTextPage(
	context: ExtensionContext,
	title: string,
	lines: readonly string[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await showPage(context, title, [pageSection(lines)], footer);
}

export function isPanelBack(data: string): boolean {
	return matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "backspace");
}

export function scrollPage(scroll: ScrollView, data: string): boolean {
	const bindings = getKeybindings();
	const distances = new Map<Keybinding, number>([
		["tui.editor.cursorUp", -1],
		["tui.editor.cursorDown", 1],
		["tui.editor.pageUp", -Math.max(1, scroll.viewportHeight - 1)],
		["tui.editor.pageDown", Math.max(1, scroll.viewportHeight - 1)],
	]);
	const distance = [...distances].find(([key]) => bindings.matches(data, key))?.[1];
	if (distance !== undefined) {
		scroll.scrollBy(distance ?? 0);
		return true;
	}
	return scrollPageBoundary(scroll, data);
}

function scrollPageBoundary(scroll: ScrollView, data: string): boolean {
	const bindings = getKeybindings();
	if (bindings.matches(data, "tui.editor.cursorLineStart")) {
		scroll.scrollToStart();
		return true;
	}
	if (bindings.matches(data, "tui.editor.cursorLineEnd")) {
		scroll.scrollToEnd();
		return true;
	}
	return false;
}

function addPageContent(container: Container, theme: Theme, title: string, sections: readonly PageSection[]): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	addPageSections(container, theme, sections);
}

export function addPageSections(container: Container, theme: Theme, sections: readonly PageSection[]): void {
	const visibleSections = sections.filter((section) => section.lines.some((line) => line.trim().length > 0));
	for (const [index, section] of visibleSections.entries()) {
		if (index > 0) container.addChild(new Spacer(1));
		if (section.heading !== undefined) {
			container.addChild(new Text(theme.fg("accent", theme.bold(section.heading)), 1, 0));
		}
		container.addChild(new Text(theme.fg("muted", section.lines.join("\n")), 1, 0));
	}
}

export async function showPage(
	context: ExtensionContext,
	title: string,
	sections: readonly PageSection[],
	footer = PANEL_BACK_FOOTER,
): Promise<void> {
	await context.ui.custom<void>((_tui, theme, _keybindings, done) => {
		const content = new Container();
		addPageContent(content, theme, title, sections);
		const scroll = new ScrollView(content, { overscroll: "contain", scrollbar: "auto" });
		const footerContainer = new Container();
		addPanelKeybindings(footerContainer, theme, footer);
		const page = new VStack([scroll, { component: footerContainer, shrink: 0 }]);
		// SAFETY: The custom page adds only the input handler while preserving VStack and ScrollView layout contracts.
		const interactivePage = page as VStack & { handleInput: (data: string) => void };
		interactivePage.handleInput = (data: string): void => {
			if (scrollPage(scroll, data)) return;
			if (isPanelBack(data)) done();
		};
		return interactivePage;
	});
}

export const NAVIGATION_FOOTER = "up/down move  enter select  escape/ctrl+c/backspace back";
export const RECORD_NAVIGATION_FOOTER = "up/down move  enter inspect  escape/ctrl+c/backspace back";
export const PANEL_BACK_FOOTER = "escape/ctrl+c/backspace back";

export function addPanelKeybindings(container: Container, theme: Theme, footer: string): Text {
	const keybindings = new Text(theme.fg("dim", footer), 1, 0);
	container.addChild(keybindings);
	container.addChild(new Spacer(1));
	return keybindings;
}

export function addHeading(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
}

export function formatFieldRows(rows: readonly (readonly [string, string])[]): readonly string[] {
	if (rows.length === 0) return [];
	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	return rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
}

export function addKeyValueRows(
	container: Container,
	theme: Theme,
	rows: readonly (readonly [string, string])[],
	labelWidth?: number,
): void {
	if (rows.length === 0) return;
	const width = labelWidth ?? Math.max(...rows.map(([label]) => label.length));
	container.addChild({
		render: (availableWidth: number) =>
			wrappedFieldRows(rows, availableWidth, width).map((line) => theme.fg("muted", line)),
		invalidate: () => {},
	});
}

function wrappedFieldRows(
	rows: readonly (readonly [string, string])[],
	width: number,
	labelWidth: number,
): readonly string[] {
	return rows.flatMap(([label, value]) => {
		const prefix = `${label.padEnd(labelWidth)}  `;
		const wrapped = wrapTextWithAnsi(value, Math.max(1, width - prefix.length));
		return wrapped.map((line, index) =>
			truncateToWidth(`${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`, width, ""),
		);
	});
}

export function selectorTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => theme.fg("accent", theme.bold(text)),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

export function selectableComponent(
	container: Component,
	list: SelectList,
	tui: { requestRender(): void },
	onBack: () => void,
	interceptInput?: (data: string) => boolean,
): Component {
	return Object.assign(container, {
		handleInput: (data: string) => {
			if (interceptInput?.(data) === true) return;
			if (matchesKey(data, "backspace")) {
				onBack();
				return;
			}
			list.handleInput(data);
			tui.requestRender();
		},
	});
}
