import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Actor, RecordView, WorkView } from "./model.js";
import type { ApplicationService } from "./service.js";
import { formatEvidenceSupplement, selectRelevantEvidence, showSelectedRecord } from "./tui-evidence.js";
import { pageSection, type RecordListMode, showTextPage } from "./tui-pages.js";
import { type RecordPanelResult, selectRecordPanel } from "./tui-record-list.js";

function readArchivePage(service: ApplicationService, work: WorkView, actor: Actor, cursor?: string) {
	return service.readRecords(
		{ workId: work.workId, order: "desc" },
		{ actor, commandId: `tui:archive:${work.workId}:${work.revision}`, schemaVersion: 1 },
		cursor,
	);
}

type ArchivePageState = Readonly<{
	page: ReturnType<ApplicationService["readRecords"]>;
	records: readonly RecordView[];
}>;

function advanceArchivePage(
	selected: RecordPanelResult,
	state: ArchivePageState,
	service: ApplicationService,
	work: WorkView,
	actor: Actor,
): ArchivePageState | undefined {
	if (selected === "newest") {
		const page = readArchivePage(service, work, actor);
		return { page, records: [...page.items] };
	}
	if (selected === "older" && state.page.nextCursor !== undefined) {
		const page = readArchivePage(service, work, actor, state.page.nextCursor);
		return { page, records: [...page.items] };
	}
	return undefined;
}

export async function runArchivePages(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
	mode: RecordListMode,
): Promise<void> {
	let state: ArchivePageState = { page: readArchivePage(service, work, actor), records: [] };
	state = { page: state.page, records: [...state.page.items] };
	for (;;) {
		const selected = await selectRecordPanel(
			visibleArchiveRecords(mode, work, state.records),
			context,
			mode,
			[...formatEvidenceSupplement(work), pageSection([`Saved through sequence ${state.page.asOfSequence}`])],
			{ older: state.page.nextCursor !== undefined, newest: true },
		);
		if (selected === null) return;
		state = await navigateArchivePage(selected, state, service, work, actor, context);
	}
}

async function navigateArchivePage(
	selected: string,
	state: ArchivePageState,
	service: ApplicationService,
	work: WorkView,
	actor: Actor,
	context: ExtensionContext,
): Promise<ArchivePageState> {
	try {
		const next = advanceArchivePage(selected, state, service, work, actor);
		if (next !== undefined) return next;
		await showSelectedRecord(state.records, selected, context);
	} catch (error) {
		context.ui.notify(`Archive page unavailable: ${String(error)}`, "error");
	}
	return state;
}

function visibleArchiveRecords(mode: RecordListMode, work: WorkView, records: readonly RecordView[]): RecordView[] {
	const selected = mode === "evidence" ? selectRelevantEvidence(work, records) : records;
	return [...selected].sort((left, right) => right.sequence - left.sequence);
}

export async function showArchive(
	service: ApplicationService,
	context: ExtensionContext,
	work: WorkView,
	actor: Actor,
): Promise<void> {
	try {
		await runArchivePages(service, context, work, actor, "archive");
	} catch (error) {
		await showTextPage(context, "Archive", [
			`Unable to read Archive: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
}

export async function showEvidence(
	service: ApplicationService,
	work: WorkView,
	context: ExtensionContext,
	actor: Actor,
): Promise<void> {
	try {
		await runArchivePages(service, context, work, actor, "evidence");
	} catch (error) {
		await showTextPage(context, "Evidence", [
			`Unable to read Archive: ${error instanceof Error ? error.message : String(error)}`,
		]);
	}
}
