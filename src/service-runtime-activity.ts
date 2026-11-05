import type { ArchivePort } from "./archive.js";
import type { CommandMeta, WorkView } from "./model.js";
import type { AgentRuntimePort, RuntimeActivitySnapshot, RuntimeBinding } from "./ports.js";
import type { ArchiveCore } from "./service-archive-core.js";
import { sameRuntimeBinding } from "./service-state-policy.js";

export type WorkActivitySnapshot =
	| RuntimeActivitySnapshot
	| Readonly<{ state: "detached"; entries: readonly []; discarded: 0 }>;
export type WorkActivitySubscription = Readonly<{ snapshot: () => WorkActivitySnapshot; close: () => void }>;

function currentExecution(work: WorkView | undefined, executionId: string, binding: RuntimeBinding): boolean {
	if (work === undefined) return false;
	return [
		work.state !== "succeeded",
		work.state !== "stopped",
		work.execution?.executionId === executionId,
		sameRuntimeBinding(work.execution?.pi, binding),
	].every(Boolean);
}

function notifyViewer(onChange: () => void): void {
	try {
		void Promise.resolve(onChange()).catch(() => undefined);
	} catch {
		// A viewer must not interrupt the governed runtime.
	}
}

export function observeWorkExecutor(
	core: ArchiveCore,
	archive: ArchivePort,
	runtime: AgentRuntimePort,
	workId: string,
	meta: CommandMeta,
	onChange: () => void,
): WorkActivitySubscription {
	core.requireActor(meta, "user");
	const work = core.inspectWork(workId);
	core.checkRevision(work, meta);
	const execution = core.requireExecution(work);
	const binding = execution.pi;
	if (binding === undefined)
		throw core.error(
			"invalid-state",
			"The Work has no current Executor runtime to observe.",
			false,
			"Inspect the Work before retrying.",
		);
	if (!currentExecution(work, execution.executionId, binding))
		throw core.error(
			"invalid-state",
			"The Work has no current Executor runtime to observe.",
			false,
			"Inspect the Work before retrying.",
		);
	let ready = false;
	let state: "open" | "detached" | "closed" = "open";
	const isCurrent = (): boolean => {
		try {
			return currentExecution(archive.project(workId), execution.executionId, binding);
		} catch {
			return false;
		}
	};
	const detach = (): void => {
		if (state !== "open") return;
		state = "detached";
		subscription.close();
	};
	const notify = (): void => {
		if (state !== "open" || !ready) return;
		if (!isCurrent()) detach();
		notifyViewer(onChange);
	};
	const subscription = runtime.observe(binding, notify);
	ready = true;
	if (!isCurrent()) {
		detach();
		throw core.error(
			"revision-conflict",
			"The Work's Executor changed while observation was starting.",
			true,
			"Reread the Work and retry.",
		);
	}
	const requireOpen = (): void => {
		if (state === "closed") throw new Error("Work activity subscription is closed.");
	};
	const visible = (snapshot: RuntimeActivitySnapshot): WorkActivitySnapshot => {
		requireOpen();
		if (!isCurrent()) detach();
		return state === "detached" ? { state: "detached", entries: [], discarded: 0 } : snapshot;
	};
	return {
		snapshot: () => {
			requireOpen();
			if (!isCurrent()) detach();
			if (state === "detached") return { state: "detached", entries: [], discarded: 0 };
			return visible(subscription.snapshot());
		},
		close: () => {
			const wasOpen = state === "open";
			state = "closed";
			if (wasOpen) subscription.close();
		},
	};
}
