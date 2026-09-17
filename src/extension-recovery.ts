import { meta } from "./extension-role.js";
import type { ApplicationRuntime } from "./factory.js";
import type { WorkView } from "./model.js";
import { ApplicationError } from "./service.js";

export type RecoveryReport = Readonly<{
	completed: number;
	failures: readonly Readonly<{ workId: string; error: Error }>[];
}>;

export async function recoverUserWork(
	service: ApplicationRuntime["service"],
	work: readonly ReturnType<ApplicationRuntime["service"]["listWork"]>[number][],
): Promise<RecoveryReport> {
	const failures: { workId: string; error: Error }[] = [];
	for (const item of work) {
		try {
			await recoverItem(service, item.workId);
		} catch (error) {
			failures.push({ workId: item.workId, error: error instanceof Error ? error : new Error(String(error)) });
		}
	}
	return { completed: work.length - failures.length, failures };
}

async function recoverItem(service: ApplicationRuntime["service"], workId: string): Promise<void> {
	const current = service.inspectWork(workId);
	const recovered = await service.recoverWork(
		workId,
		meta("user", `recover:${workId}:${current.revision}`, current.revision),
	);
	if (!recoveryFailed(current, recovered)) return;
	throw new ApplicationError(
		recovered.lastError ?? {
			code: "external-failure",
			summary: "The Executor runtime could not be restored.",
			retryable: true,
			remediation: "Inspect Work Evidence before retrying recovery.",
			evidenceRefs: [],
		},
	);
}

function recoveryFailed(current: WorkView, recovered: WorkView): boolean {
	if (["stopped", "succeeded"].includes(current.state)) return false;
	return recovered.execution?.state === "failed";
}
