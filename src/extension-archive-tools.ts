import { nestedConclaveWorkId } from "./extension-role.js";
import { type Actor, type MutableRecordQuery, parseRecordKind, type RecordKind } from "./model.js";
import { ApplicationError } from "./service.js";

type ArchiveQueryParams = Readonly<{
	workId?: string | undefined;
	missionId?: string | undefined;
	executionId?: string | undefined;
	kinds?: readonly string[] | undefined;
	states?: readonly string[] | undefined;
	from?: string | undefined;
	to?: string | undefined;
}>;

export function readArchiveQuery(params: ArchiveQueryParams, actor: Actor, toolCallId: string): MutableRecordQuery {
	const scopedWorkId = boundWorkId(actor, toolCallId);
	assertArchiveWorkScope(params.workId, scopedWorkId);
	return {
		order: "desc",
		workId: scopedWorkId ?? params.workId,
		missionId: params.missionId,
		executionId: params.executionId,
		kinds: params.kinds === undefined ? undefined : readRecordKinds(params.kinds),
		states: params.states,
		from: params.from,
		to: params.to,
	};
}

function assertArchiveWorkScope(workId: string | undefined, bound: string | undefined): void {
	if (bound === undefined) return;
	if (workId === undefined || workId === bound) return;
	throw new ApplicationError({
		code: "forbidden",
		summary: "A bound role may only read its assigned Work.",
		retryable: false,
		remediation: "Omit workId or use the Work ID from the role binding.",
		evidenceRefs: [],
	});
}

function boundWorkId(actor: Actor, toolCallId: string): string | undefined {
	if (actor === "conclave") return nestedConclaveWorkId(toolCallId);
	if (actor === "observer" || actor === "executor") return process.env["KHALA_BOUND_WORK_ID"];
	return undefined;
}

function readRecordKinds(values: readonly string[]): readonly RecordKind[] {
	try {
		return values.map(parseRecordKind);
	} catch (error) {
		throw new ApplicationError({
			code: "invalid-input",
			summary: error instanceof Error ? error.message : "Archive record kind is invalid.",
			retryable: false,
			remediation: "Use one of the supported Archive record kinds.",
			evidenceRefs: [],
		});
	}
}
