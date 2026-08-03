// biome-ignore-all lint/complexity/useMaxParams: Delivery receives the archive identity, Verdict, execution fence, and transport as separate boundaries.
// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: Delivery writes pending, delivered, and failed evidence as one retryable operation.
// biome-ignore-all lint/style/noTernary: Error normalization and optional transport metadata are explicit at the delivery boundary.
import { nanoid } from "nanoid";
import { appendArchiveRecord, withArchiveLock } from "./khala-archive.js";
import { listLatestVerdictDeliveryRecords } from "./khala-archive-projections.js";
import type { ExecutorRecord, VerdictDeliveryRecord, VerdictRecord } from "./khala-model.js";

type ExecutorMessageSender = (execution: ExecutorRecord, message: string) => Promise<void>;

function verdictMessage(verdict: VerdictRecord): string {
	return [
		`Khala Conclave Verdict: ${verdict.decision}.`,
		`Reason: ${verdict.reason}`,
		`Verdict ID: ${verdict.verdictId}.`,
		"Read the authoritative Archive and follow the Verdict before taking further action.",
	].join(" ");
}

async function deliverVerdict(
	projectPath: string,
	verdict: VerdictRecord,
	projectTrusted: boolean,
	execution: ExecutorRecord | undefined,
	send: ExecutorMessageSender,
): Promise<VerdictDeliveryRecord> {
	const message = verdictMessage(verdict);
	const deliveryId = nanoid();
	const createdAt = new Date().toISOString();
	const pending: VerdictDeliveryRecord = {
		deliveryId,
		verdictId: verdict.verdictId,
		workId: verdict.workId,
		executionId: verdict.executionId,
		decision: verdict.decision,
		message,
		status: "pending",
		createdAt,
	};
	let existing: VerdictDeliveryRecord | undefined;
	let pendingAppended = false;
	withArchiveLock(projectPath, projectTrusted, () => {
		existing = listLatestVerdictDeliveryRecords(projectPath, projectTrusted).find(
			(record) => record.verdictId === verdict.verdictId,
		);
		if (existing?.status === "delivered" || existing?.status === "pending") {
			return;
		}
		appendArchiveRecord(
			projectPath,
			{
				schemaVersion: 2,
				type: "verdict-delivery",
				workId: verdict.workId,
				executionId: verdict.executionId,
				payload: pending,
			},
			projectTrusted,
		);
		pendingAppended = true;
	});
	if (existing !== undefined && !pendingAppended) {
		return existing;
	}
	const canSendHeadless = execution?.kind === "executor" && execution.launcher === "headless-rpc";
	if (execution === undefined || !canSendHeadless) {
		return pending;
	}
	try {
		await send(execution, message);
		const delivered: VerdictDeliveryRecord = {
			...pending,
			status: "delivered",
			launcher: execution.launcher,
			deliveredAt: new Date().toISOString(),
		};
		withArchiveLock(projectPath, projectTrusted, () => {
			appendArchiveRecord(
				projectPath,
				{
					schemaVersion: 2,
					type: "verdict-delivery",
					workId: verdict.workId,
					executionId: verdict.executionId,
					payload: delivered,
				},
				projectTrusted,
			);
		});
		return delivered;
	} catch (error) {
		const failed: VerdictDeliveryRecord = {
			...pending,
			status: "failed",
			launcher: execution.launcher,
			error: error instanceof Error ? error.message : String(error),
		};
		withArchiveLock(projectPath, projectTrusted, () => {
			appendArchiveRecord(
				projectPath,
				{
					schemaVersion: 2,
					type: "verdict-delivery",
					workId: verdict.workId,
					executionId: verdict.executionId,
					payload: failed,
				},
				projectTrusted,
			);
		});
		return failed;
	}
}

export type { ExecutorMessageSender };
export { deliverVerdict, verdictMessage };
