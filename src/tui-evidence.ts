import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import type { ProviderReviewComment, RecordKind, RecordView, Signal, WorkView } from "./model.js";
import {
	addHeading,
	addPanelKeybindings,
	formatFieldRows,
	NAVIGATION_FOOTER,
	optionalPageSection,
	type PageSection,
	pageSection,
	presentEvidenceText,
	selectableComponent,
	selectorTheme,
	showPage,
	showTextPage,
} from "./tui-pages.js";
import { formatRecordedAt, readPayloadBoolean, readPayloadText } from "./tui-record-detail.js";
import { compactRecordSummary, formatRecordPage } from "./tui-record-list.js";

function workReviewComments(work: WorkView): readonly ProviderReviewComment[] {
	const comments = (work.lastObservation?.details?.comments ?? []).filter((comment) => comment.body.trim().length > 0);
	return comments.filter((comment, index) => comments.findIndex((candidate) => candidate.id === comment.id) === index);
}

export function hasCurrentBlockedSignal(work: WorkView): boolean {
	return work.execution?.state === "blocked" && isCurrentBlockedSignal(work.lastSignal, work.execution?.executionId);
}

function isCurrentBlockedSignal(signal: Signal | undefined, executionId: string | undefined): boolean {
	return signal?.kind === "blocked" && signal.executionId === executionId;
}

const EVIDENCE_RECORD_KINDS: readonly RecordKind[] = [
	"assessment",
	"learning",
	"validation",
	"signal",
	"review-request",
	"observation",
	"delivery",
	"verdict",
	"oracle-review",
	"outcome",
	"error",
];
type EvidenceSelectionContext = Readonly<{
	missionId: string | undefined;
	executionId: string | undefined;
	reviewProviderId: string | undefined;
	reviewUrl: string | undefined;
	retainsLastError: boolean;
}>;

function evidenceSelectionContext(work: WorkView): EvidenceSelectionContext {
	const { missionId } = work.mission ?? {};
	const { executionId } = work.execution ?? {};
	const { providerId: reviewProviderId, url: reviewUrl } = work.reviewRequest ?? {};
	return { missionId, executionId, reviewProviderId, reviewUrl, retainsLastError: Boolean(work.lastError) };
}

function matchesExecution(record: RecordView, executionId: string | undefined): boolean {
	return executionId !== undefined && record.executionId === executionId;
}

function matchesMission(record: RecordView, missionId: string | undefined): boolean {
	return missionId !== undefined && record.missionId === missionId;
}

function recordMatchesBinding(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return matchesExecution(record, selection.executionId) || matchesMission(record, selection.missionId);
}

function isChangedObservationRecord(record: RecordView): boolean {
	return record.kind === "observation" && readPayloadBoolean(record.payload, "changed") === true;
}

function shouldIncludePrimaryEvidence(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		EVIDENCE_RECORD_KINDS.includes(record.kind) &&
		(recordMatchesBinding(record, selection) || isChangedObservationRecord(record) || record.evidenceRefs.length > 0)
	);
}

function addEvidenceRecord(selected: Map<number, RecordView>, record: RecordView | undefined): void {
	if (record !== undefined) selected.set(record.sequence, record);
}

function latestRecord(
	records: readonly RecordView[],
	predicate: (record: RecordView) => boolean,
): RecordView | undefined {
	return [...records].reverse().find(predicate);
}

function isRelevantErrorRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "error" && (recordMatchesBinding(record, selection) || selection.retainsLastError);
}

function signalScopeMatches(record: RecordView, selection: EvidenceSelectionContext): boolean {
	if (selection.executionId === undefined) return true;
	return recordMatchesBinding(record, selection) || matchesExecution(record, selection.executionId);
}

function isRelevantSignalRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "signal" && signalScopeMatches(record, selection);
}

function reviewRequestMatchesScope(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		(selection.reviewProviderId !== undefined &&
			readPayloadText(record.payload, "providerId") === selection.reviewProviderId) ||
		(selection.reviewUrl !== undefined && record.evidenceRefs.includes(selection.reviewUrl))
	);
}

function isRelevantReviewRequestRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return record.kind === "review-request" && reviewRequestMatchesScope(record, selection);
}

function isSupplementalEvidenceRecord(record: RecordView, selection: EvidenceSelectionContext): boolean {
	return (
		isChangedObservationRecord(record) ||
		(["delivery", "verdict", "oracle-review", "outcome"].includes(record.kind) &&
			recordMatchesBinding(record, selection))
	);
}

function addPrimaryEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	for (const record of records) {
		if (shouldIncludePrimaryEvidence(record, selection)) addEvidenceRecord(selected, record);
	}
}

function addLatestEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantErrorRecord(record, selection)),
	);
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantSignalRecord(record, selection)),
	);
	addEvidenceRecord(
		selected,
		latestRecord(records, (record) => isRelevantReviewRequestRecord(record, selection)),
	);
}

function addSupplementalEvidence(
	selected: Map<number, RecordView>,
	records: readonly RecordView[],
	selection: EvidenceSelectionContext,
): void {
	for (const record of records) {
		if (isSupplementalEvidenceRecord(record, selection)) addEvidenceRecord(selected, record);
	}
}

function addEvidenceFallback(selected: Map<number, RecordView>, records: readonly RecordView[]): void {
	if (selected.size === 0)
		addEvidenceRecord(
			selected,
			latestRecord(records, (record) => record.evidenceRefs.length > 0),
		);
}

export function selectRelevantEvidence(work: WorkView, records: readonly RecordView[]): readonly RecordView[] {
	const selected = new Map<number, RecordView>();
	const selection = evidenceSelectionContext(work);
	addPrimaryEvidence(selected, records, selection);
	addLatestEvidence(selected, records, selection);
	addSupplementalEvidence(selected, records, selection);
	addEvidenceFallback(selected, records);
	return [...selected.values()].sort((left, right) => left.sequence - right.sequence);
}

export async function showSelectedRecord(
	records: readonly RecordView[],
	selected: string,
	context: ExtensionContext,
): Promise<void> {
	const record = records.find((candidate) => String(candidate.sequence) === selected);
	if (record === undefined) return;
	const page = formatRecordPage(record);
	await showPage(context, page.title, page.sections);
}

export function formatEvidenceSupplement(work: WorkView): readonly PageSection[] {
	const next = presentEvidenceText(work.nextAction);
	return next.length === 0 ? [] : [pageSection([next], "Next")];
}
async function browseReviewComments(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<void> {
	for (;;) {
		const selected = await selectReviewComment(comments, context);
		if (selected === null) return;
		const comment = comments[Number(selected)];
		if (comment === undefined) return;
		await showPage(context, "Peer-Review comment", formatReviewCommentSections(comment));
	}
}

export async function showPeerReview(work: WorkView, context: ExtensionContext): Promise<void> {
	const comments = workReviewComments(work);
	if (comments.length === 0) {
		await showTextPage(context, "Peer-Review", [
			"Provider review comments are unavailable in the saved Work snapshot.",
		]);
		return;
	}
	await browseReviewComments(comments, context);
}

async function selectReviewComment(
	comments: readonly ProviderReviewComment[],
	context: ExtensionContext,
): Promise<string | null> {
	return context.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const list = new SelectList(
			comments.map((comment, index) => ({
				value: String(index),
				label: `${comment.author ?? "unknown author"} ${compactRecordSummary(comment.body)}`.trim(),
			})),
			Math.min(6, comments.length),
			selectorTheme(theme),
		);
		const container = new Container();
		addHeading(container, theme, "Peer-Review");
		container.addChild(new Text(theme.fg("muted", `${comments.length} comments`), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(list);
		container.addChild(new Spacer(1));
		addPanelKeybindings(container, theme, NAVIGATION_FOOTER);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		return selectableComponent(container, list, tui, () => done(null));
	});
}
function appendCommentDetail<T>(details: string[], value: T | undefined, format: (value: T) => string): void {
	if (value !== undefined) details.push(format(value));
}

function formatCommentAuthor(author: string, association: string | undefined): string {
	return `author: ${author}${association === undefined ? "" : ` (${association})`}`;
}

function reviewCommentDetails(comment: ProviderReviewComment): readonly string[] {
	const details: string[] = [];
	appendCommentDetail(details, comment.author, (author) => formatCommentAuthor(author, comment.authorAssociation));
	appendCommentDetail(details, comment.createdAt, (createdAt) => `created: ${formatRecordedAt(createdAt)}`);
	appendCommentDetail(details, comment.source, (source) => `source: ${source}`);
	appendCommentDetail(details, comment.location, (location) => `location: ${location}`);
	appendCommentDetail(details, comment.state, (state) => `state: ${state}`);
	appendCommentDetail(details, comment.minimized, (minimized) => `minimized: ${minimized ? "yes" : "no"}`);
	return details;
}

function formatReviewCommentSections(comment: ProviderReviewComment): readonly PageSection[] {
	const details = reviewCommentDetails(comment);
	const source = comment.url === undefined ? [] : [pageSection([`url: ${comment.url}`], "Source")];
	return [...optionalPageSection(details), pageSection([comment.body], "Comment"), ...source];
}

export async function showBlockingSignal(work: WorkView, context: ExtensionContext): Promise<void> {
	if (!hasCurrentBlockedSignal(work)) return;
	const signal = work.lastSignal;
	if (signal === undefined) return;
	await showPage(context, "Blocked", formatSignalSections(signal));
}

function formatSignalSections(signal: Signal): readonly PageSection[] {
	return [
		pageSection(formatFieldRows([["Observed", formatRecordedAt(signal.observedAt)]])),
		...formatExecutorEvidenceSections(signal.summary, signal.evidence),
	];
}

function formatExecutorEvidenceSections(response: string, evidence: readonly string[]): readonly PageSection[] {
	return [
		...(response.trim().length === 0 ? [] : [pageSection([response], "Executor response")]),
		...(evidence.length === 0 ? [] : [pageSection(evidence, "Evidence")]),
	];
}
