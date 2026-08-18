import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { getArchivePath } from "./khala-archive.js";
import { formatError } from "./khala-error.js";
import type { KhalaWork, WorkSubmissionRequest } from "./khala-model.js";

const DEMO_ID_LENGTH = 8;

const DEMO_WORK_TEMPLATE: KhalaWork = {
	title: "Khala live role demo",
	objective: "Run the fixed dummy Executor prompt and report every lifecycle transition through Signals.",
	context: "This is a live scripted demo. Do not edit files, run shell commands, or create real application changes.",
	scope: "Only follow the Dummy Executor Prompt below.",
	acceptanceCriteria: [
		"The Executor follows the exact attempt-specific Signal instructions.",
		"The Conclave evaluates each Signal and chooses the next lifecycle decision.",
	],
	constraints: [
		"Use khala_signal for progress, blocked, and finished state.",
		"Never call khala_verdict from an Executor.",
	],
	plan: [
		"Read the Dummy Executor Prompt in the Context section.",
		"Read the Execution attempt number supplied by the mission.",
		"Submit the exact Signals required for that attempt, then stop.",
	],
	validation: ["The Conclave must review every Signal and either finish, retry, or reject the execution."],
};

type DemoWorkflow = Readonly<{
	id: string;
	name: string;
	dummyPrompt: string;
}>;
type KhalaDemoResult = Readonly<{
	demoId: string;
	archivePath: string;
	workIds: readonly string[];
}>;
type EnsureConclaveSession = (
	projectPath: string,
	userSessionPath?: string,
	projectTrusted?: boolean,
) => string | undefined;
type SubmitDemoWork = (
	request: WorkSubmissionRequest & { projectTrusted?: boolean },
) => Promise<{ archivePath: string }>;
type KhalaDemoDependencies = Readonly<{
	ensureConclaveSession: EnsureConclaveSession;
	submitWork: SubmitDemoWork;
	openAttention: (context: ExtensionContext) => Promise<void>;
}>;

const DEMO_WORKFLOWS: readonly DemoWorkflow[] = [
	{
		id: "direct-success",
		name: "Direct Success",
		dummyPrompt: [
			"For execution attempt 1, submit exactly two Signals:",
			"1. progress — summary: Validation is running; evidence: The demo checks are in progress.",
			"2. finished — summary: The lane passed on its first attempt; evidence: All demo checks passed.",
		].join("\n"),
	},
	{
		id: "retry-success",
		name: "Retry Success",
		dummyPrompt: [
			"For execution attempt 1, submit progress followed by blocked.",
			"Use summary: The first attempt hit a recoverable failure; evidence: A fixture was unavailable.",
			"For execution attempt 2, submit progress followed by finished.",
			"Use summary: The retry passed successfully; evidence: All retry checks passed.",
		].join("\n"),
	},
	{
		id: "retry-failure",
		name: "Retry Failure",
		dummyPrompt: [
			"For execution attempt 1, submit progress followed by blocked.",
			"Use summary: The first attempt failed validation; evidence: The required invariant is false.",
			"For execution attempt 2, submit progress followed by blocked.",
			"Use summary: The retry reproduced the validation failure; evidence: The required invariant is still false.",
		].join("\n"),
	},
];

function registerKhalaDemo(pi: ExtensionAPI, dependencies: KhalaDemoDependencies): void {
	pi.registerCommand("khala-demo", {
		description: "Launch the live three-lane Khala role demo.",
		handler: async (args, context) => {
			if (args.trim().length > 0) {
				context.ui.notify("Usage: /khala-demo", "warning");
				return;
			}
			try {
				const userSessionPath = context.sessionManager.getSessionFile();
				// Demo state belongs to the project Archive and dedicated sessions, not the caller's conversation.
				const projectTrusted = typeof context.isProjectTrusted === "function" && context.isProjectTrusted();
				dependencies.ensureConclaveSession(context.cwd, userSessionPath, projectTrusted);
				const result = await runKhalaDemo(context.cwd, dependencies.submitWork, projectTrusted);
				context.ui.notify(
					[
						`Khala live demo ${result.demoId} launched.`,
						`${result.workIds.length} dummy Work submissions sent to the Conclave.`,
						"The demo does not add messages or entries to your current session.",
						`Archive: ${result.archivePath}`,
					].join("\n"),
					"info",
				);
				await dependencies.openAttention(context);
			} catch (error) {
				context.ui.notify(`Khala demo failed: ${formatError(error)}`, "error");
			}
		},
	});
}

async function runKhalaDemo(
	projectPath: string,
	submitWork: SubmitDemoWork,
	projectTrusted = false,
): Promise<KhalaDemoResult> {
	const resolvedProjectPath = resolve(projectPath);
	const demoId = nanoid(DEMO_ID_LENGTH);
	const workIds: string[] = [];
	for (const workflow of DEMO_WORKFLOWS) {
		const workId = `demo-${demoId}-${workflow.id}`;
		workIds.push(workId);
		// biome-ignore lint/performance/noAwaitInLoops: Submissions must wake the shared Conclave in deterministic order.
		await submitWork({
			workId,
			projectPath: resolvedProjectPath,
			work: createDemoWork(workflow),
			projectTrusted,
		});
	}
	return { demoId, archivePath: getArchivePath(resolvedProjectPath, projectTrusted), workIds };
}

function createDemoWork(workflow: DemoWorkflow): KhalaWork {
	return {
		...DEMO_WORK_TEMPLATE,
		title: `${DEMO_WORK_TEMPLATE.title}: ${workflow.name}`,
		context: `${DEMO_WORK_TEMPLATE.context}\n\nDummy Executor Prompt:\n${workflow.dummyPrompt}`,
	};
}

export type { KhalaDemoDependencies, KhalaDemoResult, SubmitDemoWork };
export { registerKhalaDemo, runKhalaDemo };
