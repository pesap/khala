import type { ArchivePort, PendingArchiveEffect } from "./archive.js";
import type { ErrorEnvelope, WorkView } from "./model.js";
import { isTextValue } from "./provider-observation-policy.js";
import type { ArchiveCore } from "./service-archive-core.js";

export function recordUnsupportedEffect(
	archive: ArchivePort,
	core: ArchiveCore,
	heartbeat: Map<string, string>,
	effect: PendingArchiveEffect,
): void {
	const workId = effect.payload["workId"];
	if (!isTextValue(workId)) return;
	const work = archive.project(workId);
	if (work === undefined) return;
	const marker = `unsupported-effect:${effect.effectId}`;
	if (heartbeat.has(marker)) return;
	appendUnsupportedEffect(core, heartbeat, work, effect, marker);
}

function appendUnsupportedEffect(
	core: ArchiveCore,
	heartbeat: Map<string, string>,
	work: WorkView,
	effect: PendingArchiveEffect,
	marker: string,
): void {
	const failure: ErrorEnvelope = {
		code: "integrity-failure",
		summary: `Unsupported Archive effect ${effect.kind} was retained for inspection.`,
		retryable: false,
		remediation: "Upgrade Khala to a version that supports this effect before retrying the worker.",
		evidenceRefs: [effect.effectId],
	};
	const next: WorkView = {
		...work,
		revision: work.revision + 1,
		lastError: failure,
		nextAction: "An unsupported Archive effect requires operator reconciliation.",
	};
	try {
		core.append({
			meta: {
				actor: "system",
				commandId: `${marker}:${work.revision}`,
				expectedWorkRevision: work.revision,
				schemaVersion: 1,
			},
			kind: "error",
			workId: work.workId,
			missionId: work.mission?.missionId,
			executionId: work.execution?.executionId,
			payload: { effectId: effect.effectId, kind: effect.kind, error: failure },
			projection: next,
			evidenceRefs: failure.evidenceRefs,
			summary: failure.summary,
		});
	} catch {
		// Leave both the effect and diagnostic available for the next pass.
		return;
	}
	heartbeat.set(marker, failure.summary);
}
