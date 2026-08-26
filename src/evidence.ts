import type {
	ConclaveHandoffPresentation,
	EvidencePresentation,
	JsonObject,
	JsonValue,
	ProviderObservation,
	RecordView,
	Signal,
	WorkView,
} from "./model.js";

export function buildEvidencePresentation(work: WorkView, records: readonly RecordView[]): EvidencePresentation {
	const execution = work.execution;
	const providerObservation = latestProviderObservation(work, records);
	return {
		workState: work.state,
		missionState: work.missionState,
		executionState: execution?.state,
		runtimeState: execution?.runtimeState,
		executionActive: executionIsActive(execution),
		activity: executionActivity(execution),
		signal: signalPresentation(work.lastSignal),
		archive: {
			recordCount: records.length,
			accessLabel: "Open Archive for details",
		},
		providerObservation,
		reviewRequest: work.reviewRequest,
		conclaveHandoff: latestConclaveHandoff(work, records, providerObservation),
		error: work.lastError,
	};
}

function executionIsActive(execution: WorkView["execution"]): boolean {
	return execution?.state === "running" && execution.runtimeState === "working";
}

function executionActivity(execution: WorkView["execution"]): EvidencePresentation["activity"] {
	if (execution === undefined) return "none-recorded";
	if (execution.state === "blocked") {
		return execution.runtimeState === "working" ? "executor-turn-finishing" : "awaiting-conclave";
	}
	if (execution.runtimeState === "working") return "executor-turn-active";
	if (execution.runtimeState === "pending") return "awaiting-conclave";
	return "execution-recorded";
}

function signalPresentation(signal: Signal | undefined): EvidencePresentation["signal"] {
	if (signal === undefined) return { kind: "none", evidenceCount: 0 };
	return {
		kind: signal.kind === "blocked" ? "blocking-signal" : "signal",
		evidenceCount: signal.evidence.length,
	};
}

function latestProviderObservation(work: WorkView, records: readonly RecordView[]): ProviderObservation | undefined {
	let fallback: ProviderObservation | undefined;
	for (const record of [...records].reverse()) {
		if (record.kind !== "observation" || !isProviderObservation(record.payload)) continue;
		if (fallback === undefined) fallback = record.payload;
		if (record.payload.details !== undefined) return record.payload;
	}
	return fallback ?? work.lastObservation;
}

function latestConclaveHandoff(
	work: WorkView,
	records: readonly RecordView[],
	observation: ProviderObservation | undefined,
): ConclaveHandoffPresentation | undefined {
	const observationId = observation?.observationId;
	if (observationId === undefined) return undefined;
	const handoffs = records.filter(
		(record) =>
			record.kind === "delivery" &&
			readPayloadText(record.payload, "observationId") === observationId &&
			readPayloadTextList(record.payload, "feedback") !== undefined,
	);
	const record = handoffs.at(-1);
	if (record === undefined) return undefined;
	const payload = isJsonObject(record.payload) ? record.payload : {};
	const feedback = readPayloadTextList(payload, "feedback") ?? observation?.feedback ?? [];
	const status =
		payload["delivered"] === true
			? "delivered"
			: readPayloadText(payload, "disposition") === "superseded"
				? "superseded"
				: "pending";
	return {
		observationId,
		executionId: record.executionId ?? work.execution?.executionId,
		feedback,
		status,
	};
}

function isProviderObservation(value: JsonValue): value is ProviderObservation {
	if (!isJsonObject(value)) return false;
	return (
		value["observationId"] !== undefined &&
		value["observationId"] === String(value["observationId"]) &&
		["ci-status", "review-comment", "feedback-delivery", "monitor-failure", "provider-outcome"].includes(
			String(value["kind"]),
		) &&
		value["providerId"] !== undefined &&
		value["providerId"] === String(value["providerId"]) &&
		value["status"] !== undefined &&
		value["status"] === String(value["status"]) &&
		value["summary"] !== undefined &&
		value["summary"] === String(value["summary"]) &&
		(value["changed"] === true || value["changed"] === false) &&
		value["observedAt"] !== undefined &&
		value["observedAt"] === String(value["observedAt"])
	);
}

function readPayloadText(payload: JsonValue, key: string): string | undefined {
	if (!isJsonObject(payload)) return undefined;
	const value = payload[key];
	return value !== undefined && value === String(value) ? String(value) : undefined;
}

function readPayloadTextList(payload: JsonValue, key: string): readonly string[] | undefined {
	if (!isJsonObject(payload)) return undefined;
	const value = payload[key];
	return Array.isArray(value) && value.every((entry) => entry !== undefined && entry === String(entry))
		? value.map(String)
		: undefined;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}
