import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import type { ExecutorStarter } from "./executor.js";
import { errorWithCause, formatAttachedCleanupDiagnostic, formatError } from "./khala-error.js";
import type { ExecutorStarterFactory } from "./khala-executor.js";
import {
	createExecutorRecord,
	listExecutorRecords,
	readExecutorRecord,
	updateExecutorRecord,
	writeExecutorRecord,
} from "./khala-executor-registry.js";
import { listLearningRecords } from "./khala-learning.js";
import { ExecutorStatus, type KhalaWorkSubmission } from "./khala-model.js";

const OBSERVER_PARAMETERS = Type.Object({ workId: Type.String() });
type ObserverInput = Static<typeof OBSERVER_PARAMETERS>;

type KhalaObserverDependencies = Readonly<{
	createObserverStarter: ExecutorStarterFactory;
	observerSystemPrompt: string;
	getSubmission: (
		projectPath: string,
		workId: string,
		projectTrusted?: boolean,
	) =>
		| {
				submission: KhalaWorkSubmission;
				recordId: string;
		  }
		| undefined;
	getPendingSubmission: (
		projectPath: string,
		workId: string,
		projectTrusted?: boolean,
	) => KhalaWorkSubmission | undefined;
	markSubmissionReviewing: (
		projectPath: string,
		workId: string,
		reviewAttemptId: string,
		projectTrusted?: boolean,
	) => boolean;
	markSubmissionQueued: (
		projectPath: string,
		workId: string,
		reviewAttemptIdOrTrusted?: string | boolean,
		projectTrusted?: boolean,
	) => void;
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean;
}>;

function registerKhalaObserver(pi: ExtensionAPI, dependencies: KhalaObserverDependencies): void {
	pi.registerTool({
		name: "khala_launch_observer",
		label: "Launch Khala Observer",
		description: "Launch a separate read-only Observer to gather missing Work context.",
		promptSnippet: "Launch a read-only Khala Observer",
		parameters: OBSERVER_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return launchObserver(params, context, dependencies);
		},
	});
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Observer launch keeps durable claim, resource ownership, and compensation atomic.
async function launchObserver(
	params: ObserverInput,
	context: ExtensionContext,
	dependencies: KhalaObserverDependencies,
): Promise<{
	content: [{ type: "text"; text: string }];
	details: { workId: string; executionId: string; observerName: string; destination: string; sandboxPath: string };
}> {
	const review = prepareObserverReview(params, context, dependencies);
	const { snapshot, observerName, executionId, projectTrusted } = review;
	const starting = createExecutorRecord(
		{
			executionId,
			workId: params.workId,
			executorName: observerName,
			kind: "observer",
			participantId: `observer:${executionId}`,
			purpose: { kind: "observation", submissionRecordId: snapshot.recordId },
			projectPath: context.cwd,
			sandboxPath: "",
			launcher: "pending",
		},
		ExecutorStatus.starting,
	);
	let launched: Awaited<ReturnType<ExecutorStarter>> | undefined;
	try {
		// The submission is already marked reviewing. Keep initial execution
		// materialization inside this recovery boundary so a failed Archive write
		// can return the review claim to queued.
		writeExecutorRecord(starting, projectTrusted);
		const observerStarter = dependencies.createObserverStarter(context);
		launched = await observerStarter({
			projectPath: context.cwd,
			workId: params.workId,
			executionId,
			name: `${review.snapshot.submission.work.title} observer`,
			executorName: observerName,
			mission: formatObserverMission(review.snapshot.submission),
			systemPrompt: dependencies.observerSystemPrompt,
			kind: "observer",
			participantId: `observer:${executionId}`,
			projectTrusted,
			onSandboxCreated: (sandbox, launcherName) =>
				updateExecutorRecord(
					context.cwd,
					executionId,
					{ sandboxPath: sandbox.path, launcher: launcherName },
					projectTrusted,
				),
		});
		// Learning closes the Observer pane through its registered launcher target, so a launch without
		// a closeable target cannot complete its lifecycle; fail the run and requeue the submission.
		if (launched.target === undefined) {
			throw new Error("Observer launch did not return a closeable pane target; the run cannot close its lifecycle.");
		}
		updateExecutorRecord(
			context.cwd,
			executionId,
			{ status: ExecutorStatus.running, target: launched.target },
			projectTrusted,
		);
		const destination = launched.target;
		return {
			content: [{ type: "text", text: `Observer ${observerName} launched for Work ${params.workId}.` }],
			details: { workId: params.workId, executionId, observerName, destination, sandboxPath: launched.sandbox.path },
		};
	} catch (error) {
		const current = readExecutorRecord(context.cwd, executionId, projectTrusted);
		let cleanupError = formatAttachedCleanupDiagnostic(error);
		if (current?.status === ExecutorStatus.starting || current?.status === ExecutorStatus.running) {
			try {
				await launched?.cleanup?.();
			} catch (cleanupFailure) {
				cleanupError = ` Cleanup also failed: ${formatError(cleanupFailure)}`;
			}
			updateExecutorRecord(context.cwd, executionId, { status: ExecutorStatus.failed }, projectTrusted);
		}
		dependencies.markSubmissionQueued(context.cwd, params.workId, executionId, projectTrusted);
		let message = `Observer launch failed: ${formatError(error)}`;
		message += cleanupError;
		throw errorWithCause(message, error);
	}
}

type ObserverReview = Readonly<{
	snapshot: NonNullable<ReturnType<KhalaObserverDependencies["getSubmission"]>>;
	observerName: string;
	executionId: string;
	projectTrusted: boolean;
}>;

function prepareObserverReview(
	params: ObserverInput,
	context: ExtensionContext,
	dependencies: KhalaObserverDependencies,
): ObserverReview {
	if (!dependencies.isDedicatedConclaveSession(context)) {
		throw new Error("Only the dedicated project Conclave may launch an Observer.");
	}
	const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
	const snapshot = dependencies.getSubmission(context.cwd, params.workId, projectTrusted);
	if (snapshot === undefined) {
		throw new Error(`No authoritative Work Submission exists for ID ${params.workId}.`);
	}
	const { submission } = snapshot;
	if (submission.status !== "queued") {
		throw new Error(`Work Submission ${params.workId} is not queued for review.`);
	}
	if (submission.work.context.trim().length > 0) {
		throw new Error("An Observer is only required when Work context is missing.");
	}
	if (listLearningRecords(context.cwd, params.workId, projectTrusted).length > 0) {
		throw new Error("The Archive already contains learning for this Work; inspect it before launching an Observer.");
	}
	const executions = listExecutorRecords(context.cwd, projectTrusted);
	const existingObserver = executions.find(
		(execution) =>
			execution.workId === params.workId &&
			execution.kind === "observer" &&
			(execution.status === ExecutorStatus.starting || execution.status === ExecutorStatus.running),
	);
	if (existingObserver !== undefined) {
		throw new Error(`Observer ${existingObserver.executorName} is already running for Work ${params.workId}.`);
	}
	const observerName = randomObserverName(new Set(executions.map((execution) => execution.executorName)));
	const executionId = nanoid();
	if (!dependencies.markSubmissionReviewing(context.cwd, params.workId, executionId, projectTrusted)) {
		throw new Error(`Work Submission ${params.workId} changed before Observer review could start.`);
	}
	return { snapshot, observerName, executionId, projectTrusted };
}

function randomObserverName(existing: ReadonlySet<string>): string {
	let index = 1;
	let name = `Observer-${index}`;
	while (existing.has(name)) {
		index += 1;
		name = `Observer-${index}`;
	}
	return name;
}

function formatObserverMission(submission: KhalaWorkSubmission): string {
	const { work } = submission;
	return [
		`Observe the repository context for Work ${submission.workId}: ${work.title}`,
		`Objective:\n${work.objective}`,
		`Scope:\n${work.scope}`,
		`Acceptance criteria:\n${work.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
		"Inspect only relevant repository files. Record one evidence-backed learning and stop.",
	].join("\n\n");
}

export type { KhalaObserverDependencies };
export { registerKhalaObserver };
