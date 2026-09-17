import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	getKeybindings,
	type Keybinding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RecordView } from "./model.js";
import {
	addHeading,
	addPageSections,
	addPanelKeybindings,
	formatFieldRows,
	isPanelBack,
	optionalPageSection,
	type PageSection,
	pageSection,
	RECORD_NAVIGATION_FOOTER,
	type RecordListEntry,
	type RecordListMode,
	type RecordPage,
} from "./tui-pages.js";
import {
	formatRecordedAt,
	formatStructuredFields,
	type RecordDetailFields,
	recordDetailPayloadFields,
	recordKindLabel,
	recordTitle,
	sameStringList,
} from "./tui-record-detail.js";
import { selectionMarker, tableCell } from "./tui-work-table.js";

const MAX_RECORD_LIST_SUMMARY_LENGTH = 72;
const RECORD_LIST_COLUMNS = { sequence: 5, kind: 18, actor: 12, time: 26 } as const;

export type RecordPanelResult = string | "older" | "newest" | null;

function addSupplementToRecordPanel(container: Container, theme: Theme, supplement: readonly PageSection[]): void {
	if (supplement.length > 0) container.addChild(new Spacer(1));
	addPageSections(container, theme, supplement);
}

function recordPanelFooter(navigation: Readonly<{ older: boolean; newest: boolean }>): string {
	return `${RECORD_NAVIGATION_FOOTER}${navigation.older ? "  left Older" : ""}${navigation.newest ? "  right Newest" : ""}`;
}

export async function selectRecordPanel(
	records: readonly RecordView[],
	context: ExtensionContext,
	mode: RecordListMode,
	supplement: readonly PageSection[],
	navigation: Readonly<{ older: boolean; newest: boolean }>,
): Promise<RecordPanelResult> {
	const entries: readonly RecordListEntry[] = records.map((record) => ({ kind: "record" as const, record }));
	const title = recordPanelTitle(mode, records.length);
	return context.ui.custom<RecordPanelResult>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const list = createRecordList(entries, mode, theme, () => selectedIndex);
		const container = new Container();
		addHeading(container, theme, title);
		container.addChild(new Spacer(1));
		container.addChild(list);
		if (entries.length === 0)
			container.addChild(
				new Text("No matching records on this page. Use the navigation below to continue or refresh.", 1, 0),
			);
		addSupplementToRecordPanel(container, theme, supplement);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, recordPanelFooter(navigation));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) =>
				handleRecordPanelInput(
					data,
					entries,
					() => selectedIndex,
					(value) => {
						selectedIndex = value;
					},
					tui.requestRender.bind(tui),
					done,
				),
		};
	});
}

type RecordPanelAction = "up" | "down" | "enter" | "back" | "older" | "newest";
const RECORD_PANEL_ACTIONS: ReadonlyMap<Keybinding, RecordPanelAction> = new Map([
	["tui.select.up", "up"],
	["tui.select.down", "down"],
	["tui.select.confirm", "enter"],
	["tui.editor.cursorLeft", "older"],
	["tui.editor.cursorRight", "newest"],
	["tui.select.cancel", "back"],
]);

function recordPanelAction(data: string): RecordPanelAction | undefined {
	const bindings = getKeybindings();
	const action = [...RECORD_PANEL_ACTIONS].find(([key]) => bindings.matches(data, key));
	return action?.[1] ?? (isPanelBack(data) ? "back" : undefined);
}

function moveRecordPanelSelection(
	action: "up" | "down",
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	setSelectedIndex: (index: number) => void,
	requestRender: () => void,
): void {
	setSelectedIndex(nextRecordIndex(getSelectedIndex(), entries.length, action === "up"));
	requestRender();
}

function selectRecordPanelEntry(
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	done: (value: RecordPanelResult) => void,
): void {
	const entry = entries[getSelectedIndex()];
	if (entry?.kind === "record") done(String(entry.record.sequence));
}

function handleRecordPanelInput(
	data: string,
	entries: readonly RecordListEntry[],
	getSelectedIndex: () => number,
	setSelectedIndex: (index: number) => void,
	requestRender: () => void,
	done: (value: RecordPanelResult) => void,
): void {
	const action = recordPanelAction(data);
	if (action === undefined) return;
	const handlers = new Map<RecordPanelAction, () => void>([
		["up", () => moveRecordPanelSelection("up", entries, getSelectedIndex, setSelectedIndex, requestRender)],
		["down", () => moveRecordPanelSelection("down", entries, getSelectedIndex, setSelectedIndex, requestRender)],
		["enter", () => selectRecordPanelEntry(entries, getSelectedIndex, done)],
		["older", () => done("older")],
		["newest", () => done("newest")],
		["back", () => done(null)],
	]);
	handlers.get(action)?.();
}

function recordPanelTitle(mode: RecordListMode, count: number): string {
	return mode === "evidence" ? "Evidence" : `Archive ${count} ${count === 1 ? "record" : "records"}`;
}

function nextRecordIndex(index: number, length: number, movingUp: boolean): number {
	return movingUp ? (index === 0 ? length - 1 : index - 1) : index === length - 1 ? 0 : index + 1;
}

function createRecordList(
	entries: readonly RecordListEntry[],
	mode: RecordListMode,
	theme: Theme,
	getSelectedIndex: () => number,
): Component {
	return {
		render: (width: number) => {
			const selectedIndex = getSelectedIndex();
			const maxVisible = 6;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), entries.length - maxVisible));
			const visibleEntries = entries.slice(start, start + maxVisible);
			const lines = [recordListHeader(mode, width)];
			for (const [offset, entry] of visibleEntries.entries()) {
				lines.push(...recordListEntryLines(entry, mode, width, start + offset === selectedIndex, theme));
			}
			if (start > 0 || start + visibleEntries.length < entries.length) {
				lines.push(theme.fg("dim", `  ${selectedIndex + 1} of ${entries.length}`));
			}
			return lines.map((line) => truncateToWidth(line, width, ""));
		},
		invalidate: () => {},
	};
}

type RecordListLayout = Readonly<{ kind: number; actor: number; time: number; showContext: boolean }>;

function recordListLayout(mode: RecordListMode, width: number): RecordListLayout {
	const available = Math.max(1, width - 2);
	if (mode === "evidence" && width >= 96) {
		return {
			kind: RECORD_LIST_COLUMNS.kind,
			actor: RECORD_LIST_COLUMNS.actor,
			time: RECORD_LIST_COLUMNS.time,
			showContext: true,
		};
	}
	return {
		kind: Math.max(10, Math.min(RECORD_LIST_COLUMNS.kind, Math.floor(available * 0.3))),
		actor: 0,
		time: 0,
		showContext: false,
	};
}

function recordListHeader(mode: RecordListMode, width: number): string {
	const layout = recordListLayout(mode, width);
	const sequence = tableCell("SEQ", RECORD_LIST_COLUMNS.sequence);
	const kind = tableCell("KIND", layout.kind);
	if (!layout.showContext) return `  ${sequence}${kind}SUMMARY`;
	return `  ${sequence}${kind}${tableCell("ACTOR", layout.actor)}${tableCell("TIME", layout.time)}SUMMARY`;
}

function recordListEntryLines(
	entry: RecordListEntry,
	mode: RecordListMode,
	width: number,
	selected: boolean,
	theme: Theme,
): readonly string[] {
	const record = entry.record;
	const summary = compactRecordSummary(record.summary);
	const lines =
		mode === "evidence"
			? formatEvidenceRecordLines(record, summary, width)
			: formatArchiveRecordLines(record, summary, width);
	return markRecordListEntry(lines, selected, theme);
}

function markRecordListEntry(lines: readonly string[], selected: boolean, theme: Theme): readonly string[] {
	const marked = lines.map((line, index) => (index === 0 ? `${selectionMarker(selected)}${line.slice(2)}` : line));
	return selected ? marked.map((line) => theme.fg("accent", theme.bold(line))) : marked;
}

export function compactRecordSummary(summary: string): string {
	const firstLine = summary.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
	return truncateToWidth(firstLine.replace(/\s+/g, " ").trim(), MAX_RECORD_LIST_SUMMARY_LENGTH, "");
}

function formatEvidenceRecordLines(record: RecordView, summary: string, width: number): readonly string[] {
	const layout = recordListLayout("evidence", width);
	let prefix = `  ${tableCell(String(record.sequence), RECORD_LIST_COLUMNS.sequence)}${tableCell(recordKindLabel(record), layout.kind)}`;
	if (layout.showContext) {
		prefix += `${tableCell(record.actor, layout.actor)}${tableCell(formatRecordedAt(record.recordedAt), layout.time)}`;
	}
	return summary.trim().length === 0
		? [prefix.trimEnd()]
		: [`${prefix}${truncateToWidth(summary, Math.max(1, width - visibleWidth(prefix)), "...")}`];
}

function formatArchiveRecordLines(record: RecordView, summary: string, width: number): readonly string[] {
	const layout = recordListLayout("archive", width);
	const prefix = `  ${tableCell(String(record.sequence), RECORD_LIST_COLUMNS.sequence)}${tableCell(recordKindLabel(record), layout.kind)}`;
	return summary.trim().length === 0 ? [prefix.trimEnd()] : wrapPrefixed(summary, prefix, visibleWidth(prefix), width);
}

function wrapPrefixed(value: string, prefix: string, prefixWidth: number, width: number): readonly string[] {
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(value.length === 0 ? " " : value, available);
	return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}
function appendRecordMetadata(
	metadata: Array<readonly [string, string]>,
	label: string,
	value: string | number | undefined,
): void {
	if (value !== undefined) metadata.push([label, String(value)]);
}

function recordMetadata(record: RecordView): readonly (readonly [string, string])[] {
	const metadata: Array<readonly [string, string]> = [
		["Recorded", formatRecordedAt(record.recordedAt)],
		["Actor", record.actor],
		["Record number", String(record.recordNumber)],
	];
	appendRecordMetadata(metadata, "Mission record number", record.missionRecordNumber);
	metadata.push(["Record ID", record.id], ["Work ID", record.workId]);
	appendRecordMetadata(metadata, "Mission ID", record.missionId);
	appendRecordMetadata(metadata, "Execution ID", record.executionId);
	metadata.push(["Payload version", String(record.payloadVersion)]);
	return metadata;
}

function recordEvidenceReferences(fields: RecordDetailFields, evidenceRefs: readonly string[]): readonly string[] {
	if (fields.displayedEvidence === undefined) return evidenceRefs;
	return sameStringList(fields.displayedEvidence, evidenceRefs) ? [] : evidenceRefs;
}

function recordPageSections(
	metadata: readonly (readonly [string, string])[],
	payloadFields: RecordDetailFields,
	structuredFields: readonly string[],
	evidenceReferences: readonly string[],
): readonly PageSection[] {
	return [
		pageSection(formatFieldRows(metadata)),
		...payloadFields.sections,
		...optionalPageSection(structuredFields, "Structured fields"),
		...optionalPageSection(evidenceReferences, "Evidence references"),
	];
}

export function formatRecordPage(record: RecordView): RecordPage {
	const payloadFields = recordDetailPayloadFields(record);
	const structuredFields = formatStructuredFields(record.payload, payloadFields.displayed);
	return {
		title: recordTitle(record),
		sections: recordPageSections(
			recordMetadata(record),
			payloadFields,
			structuredFields,
			recordEvidenceReferences(payloadFields, record.evidenceRefs),
		),
	};
}
