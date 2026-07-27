import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { KhalaEntryType } from "./khala-entry-types.js";
import type { ExecutorStarterFactory } from "./khala-executor.js";
import {
	type KhalaWork,
	KhalaWorkEntryStatus,
	type KhalaWorkLaunchStatus,
	type KhalaWorkSubmission,
} from "./khala-model.js";
import { queueWork, rejectedWorkLaunch, toKhalaWork, validateWork } from "./khala-work-helpers.js";
import { admitWork, launchExecution } from "./khala-work-lifecycle.js";

const WORK_PARAMETERS = Type.Object({
	workId: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	objective: Type.String(),
	context: Type.Optional(Type.String()),
	scope: Type.String(),
	acceptanceCriteria: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	plan: Type.Array(Type.String()),
	validation: Type.Array(Type.String()),
});
const ADMIT_WORK_PARAMETERS = Type.Object({ workId: Type.String() });
const LAUNCH_EXECUTION_PARAMETERS = Type.Object({ workId: Type.String() });
type KhalaWorkInput = Static<typeof WORK_PARAMETERS>;
type KhalaAdmitWorkInput = Static<typeof ADMIT_WORK_PARAMETERS>;
type KhalaLaunchExecutionInput = Static<typeof LAUNCH_EXECUTION_PARAMETERS>;
type KhalaWorkDraft = Readonly<{ workId: string; status: typeof KhalaWorkEntryStatus.draft }>;

type KhalaWorkDependencies = Readonly<{
	workTemplate: string;
	executorSystemPrompt: string;
	createExecutorStarter: ExecutorStarterFactory;
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean;
	submitWork: (request: {
		workId: string;
		projectPath: string;
		work: KhalaWork;
		projectTrusted?: boolean;
	}) => Promise<{ archivePath: string }>;
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
	claimSubmission: (projectPath: string, workId: string, projectTrusted?: boolean) => boolean;
	markSubmissionQueued: (
		projectPath: string,
		workId: string,
		reviewAttemptIdOrTrusted?: string | boolean,
		projectTrusted?: boolean,
	) => void;
	markSubmissionLaunched: (
		projectPath: string,
		workId: string,
		result: { target?: string | undefined; sandboxPath: string },
		projectTrusted?: boolean,
	) => void;
}>;

type KhalaWorkLaunchResult =
	| {
			content: [{ type: "text"; text: string }];
			details: { status: typeof KhalaWorkLaunchStatus.queued; workId: string; archivePath: string };
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.starting;
				workId: string;
				executionId: string;
				missionId: string;
			};
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.launched;
				workId: string;
				executionId: string;
				executorName: string;
				destination: string;
				sandboxPath: string;
				missionId: string;
				mandateId: string;
			};
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: { status: typeof KhalaWorkLaunchStatus.rejected; reason: string };
			isError: true;
	  };

type KhalaAdmissionResult =
	| {
			content: [{ type: "text"; text: string }];
			details: { workId: string; mandateId: string; revision: number; status: "admitted" };
	  }
	| { content: [{ type: "text"; text: string }]; details: { status: "rejected"; reason: string }; isError: true };

function registerKhalaWork(pi: ExtensionAPI, dependencies: KhalaWorkDependencies): void {
	pi.registerCommand("khala-work", {
		description: "Load the Khala Work template into the Pi editor.",
		handler: (args, context) => {
			if (args.trim().length > 0) {
				context.ui.notify("Usage: /khala-work", "warning");
				return Promise.resolve();
			}
			loadWorkTemplate(pi, context, dependencies);
			return Promise.resolve();
		},
	});
	pi.registerTool({
		name: "khala_submit_work",
		label: "Submit Khala Work",
		description: "Submit a completed Khala Work to the dedicated project Conclave.",
		promptSnippet: "Submit completed Khala Work",
		executionMode: "sequential",
		parameters: WORK_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return submitValidatedWork(pi, params, context, dependencies);
		},
	});
	pi.registerTool({
		name: "khala_admit_work",
		label: "Admit Khala Work",
		description: "Admit one validated Work Submission under a durable Mandate.",
		promptSnippet: "Admit Work and create Mandate revision one",
		executionMode: "sequential",
		parameters: ADMIT_WORK_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return Promise.resolve(admitWork(params, context, dependencies));
		},
	});
	pi.registerTool({
		name: "khala_launch_execution",
		label: "Launch Khala Execution",
		description: "Launch the authoritative admitted Work in an isolated Executor session.",
		promptSnippet: "Launch the admitted Khala Mission",
		executionMode: "sequential",
		parameters: LAUNCH_EXECUTION_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return launchExecution(pi, params, context, dependencies);
		},
	});
}

function loadWorkTemplate(
	pi: ExtensionAPI,
	context: ExtensionCommandContext,
	dependencies: KhalaWorkDependencies,
): void {
	if (!context.hasUI) {
		context.ui.notify("The Khala Work template requires an interactive Pi editor.", "warning");
		return;
	}
	const workId = nanoid();
	pi.appendEntry(KhalaEntryType.work, { status: KhalaWorkEntryStatus.draft, workId });
	context.ui.setEditorText(dependencies.workTemplate);
	context.ui.notify("Khala Work template loaded. Fill it out, then submit it to the Conclave.", "info");
}

function submitValidatedWork(
	pi: ExtensionAPI,
	params: KhalaWorkInput,
	context: ExtensionContext,
	dependencies: KhalaWorkDependencies,
): Promise<KhalaWorkLaunchResult> {
	const work = toKhalaWork(params);
	const validationErrors = validateWork(work);
	if (validationErrors.length > 0) {
		return Promise.resolve(rejectedWorkLaunch(`Khala Work is incomplete:\n- ${validationErrors.join("\n- ")}`));
	}
	return queueWork(pi, work, context, dependencies);
}

export type {
	KhalaAdmissionResult,
	KhalaAdmitWorkInput,
	KhalaLaunchExecutionInput,
	KhalaWorkDependencies,
	KhalaWorkDraft,
	KhalaWorkInput,
	KhalaWorkLaunchResult,
};
export { registerKhalaWork };
