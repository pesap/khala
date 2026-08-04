// biome-ignore-all lint/style/noExcessiveLinesPerFile: Work registration and render contracts share one public tool boundary.
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { nanoid } from "nanoid";
import { type Static, Type } from "typebox";
import { KhalaEntryType } from "./khala-entry-types.js";
import type { ExecutorStarterFactory } from "./khala-executor.js";
import {
	type ConclaveWakeFailure,
	type KhalaWork,
	KhalaWorkEntryStatus,
	KhalaWorkLaunchStatus,
	type KhalaWorkSubmission,
} from "./khala-model.js";
import { isUserSessionRole, readSessionRole } from "./khala-role.js";
import { deriveWorkTitle, queueWork, rejectedWorkLaunch, toKhalaWork, validateWork } from "./khala-work-helpers.js";
import { admitWork, launchExecution } from "./khala-work-lifecycle.js";
import { renderExpandHint, renderSubmitWorkStatus } from "./khala-work-render.js";

const WORK_PARAMETERS = Type.Object({
	workId: Type.Optional(
		Type.String({ description: "Stable Work ID; uses the active template draft ID or generates one when omitted." }),
	),
	title: Type.Optional(Type.String({ description: "Short Work title; derived from objective when omitted." })),
	objective: Type.String(),
	context: Type.Optional(Type.String()),
	scope: Type.String(),
	acceptanceCriteria: Type.Array(Type.String()),
	constraints: Type.Array(Type.String()),
	plan: Type.Array(Type.String()),
	validation: Type.Array(Type.String()),
	costBudget: Type.Optional(
		Type.Object({
			conclaveMaxCostUsdPerTurn: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			executorMaxCostUsdPerTurn: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		}),
	),
});
const ADMIT_WORK_PARAMETERS = Type.Object({ workId: Type.String() });
const LAUNCH_EXECUTION_PARAMETERS = Type.Object({
	workId: Type.String(),
	mode: Type.Optional(Type.Union([Type.Literal("materialize"), Type.Literal("launch")])),
});
type KhalaWorkInput = Static<typeof WORK_PARAMETERS>;
type KhalaAdmitWorkInput = Static<typeof ADMIT_WORK_PARAMETERS>;
type KhalaLaunchExecutionInput = Static<typeof LAUNCH_EXECUTION_PARAMETERS>;
type KhalaWorkDraft = Readonly<{ workId: string; status: typeof KhalaWorkEntryStatus.draft }>;

type KhalaWorkDependencies = Readonly<{
	workTemplate: string;
	executorSystemPrompt: string;
	createExecutorStarter: ExecutorStarterFactory;
	isDedicatedConclaveSession: (context: ExtensionContext) => boolean;
	submitWork: (request: { workId: string; projectPath: string; work: KhalaWork; projectTrusted?: boolean }) => Promise<{
		archivePath: string;
		wakeFailure?: ConclaveWakeFailure;
	}>;
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
		result: { sandboxPath: string },
		projectTrusted?: boolean,
	) => void;
	pollBeforeDependentLaunch?: (projectPath: string, projectTrusted: boolean, workId?: string) => Promise<void>;
}>;

type KhalaWorkLaunchResult =
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.queued;
				workId: string;
				archivePath: string;
			};
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.materialized;
				workId: string;
				missionId: string;
				mandateId: string;
			};
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.held;
				workId: string;
				missionId: string;
				coordinationId: string;
				reason: string;
			};
	  }
	| {
			content: [{ type: "text"; text: string }];
			details: {
				status: typeof KhalaWorkLaunchStatus.starting;
				workId: string;
				executionId: string;
				missionId: string;
				executorName: string;
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
	pi.registerTool(createSubmitWorkTool(pi, dependencies));
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
		description:
			"Materialize an admitted Mission without an Executor when mode is materialize, or launch its headless Executor when mode is launch or omitted.",
		promptSnippet: "Materialize or launch the admitted Khala Mission",
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
	const role = readSessionRole(context);
	if (!isUserSessionRole(role)) {
		return Promise.resolve(rejectedWorkLaunch("Only a User may submit Work."));
	}
	const work = toKhalaWork(params);
	const validationErrors = validateWork(work);
	if (validationErrors.length > 0) {
		return Promise.resolve(rejectedWorkLaunch(`Khala Work is incomplete:\n- ${validationErrors.join("\n- ")}`));
	}
	return queueWork({ pi, work, explicitWorkId: params.workId, context, dependencies });
}

function createSubmitWorkTool(
	pi: ExtensionAPI,
	dependencies: KhalaWorkDependencies,
): ToolDefinition<typeof WORK_PARAMETERS, KhalaWorkLaunchResult["details"]> {
	return {
		name: "khala_submit_work",
		label: "Submit Khala Work",
		description:
			"Submit a complete Khala Work directly to the project Conclave. This tool is Pi-native and does not require an active /khala-work draft.",
		promptSnippet: "Submit completed Khala Work directly to the project Conclave",
		executionMode: "sequential",
		parameters: WORK_PARAMETERS,
		execute: (...args) => {
			const [, params, , , context] = args;
			return submitValidatedWork(pi, params, context, dependencies);
		},
		renderCall: (args, theme) => renderSubmitWorkCall(args, theme),
		renderResult: (result, options, theme, context) => renderSubmitWorkResult(result, options, theme, context.args),
	};
}

function renderSubmitWorkCall(args: KhalaWorkInput, theme: Theme): Component {
	const { title: rawTitle, objective: rawObjective } = args;
	let suppliedTitle = "";
	if (typeof rawTitle === "string") {
		suppliedTitle = rawTitle.trim();
	}
	let objective = "";
	if (typeof rawObjective === "string") {
		objective = rawObjective;
	}
	const title = suppliedTitle || deriveWorkTitle(rawTitle, objective);
	return new Text(theme.fg("toolTitle", theme.bold("khala_submit_work ")) + theme.fg("muted", `"${title}"`), 0, 0);
}

function renderSubmitWorkResult(
	result: AgentToolResult<KhalaWorkLaunchResult["details"]>,
	options: ToolRenderResultOptions,
	theme: Theme,
	params: KhalaWorkInput,
): Component {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Submitting Khala Work..."), 0, 0);
	}
	const { details, content } = result;
	if (details === undefined) {
		const [text] = content;
		let fallback = "";
		if (text?.type === "text") {
			fallback = text.text;
		}
		return new Text(fallback, 0, 0);
	}
	if (details.status === KhalaWorkLaunchStatus.rejected) {
		return new Text(theme.fg("error", `Work submission rejected: ${details.reason}`), 0, 0);
	}
	const work = toKhalaWork(params);
	let text = renderSubmitWorkStatus(details, work, theme);
	if (options.expanded && details.status === KhalaWorkLaunchStatus.queued) {
		text += `\n${renderExpandedWork(work, details, theme)}`;
	} else if (!options.expanded) {
		text += `\n${renderExpandHint(theme)}`;
	}
	return new Text(text, 0, 0);
}

function renderExpandedWork(work: KhalaWork, details: KhalaWorkLaunchResult["details"], theme: Theme): string {
	if (details.status !== KhalaWorkLaunchStatus.queued) {
		return "";
	}
	const sections = [
		`Work ID: ${details.workId}`,
		`Archive: ${details.archivePath}`,
		`Objective:\n${work.objective}`,
		`Context:\n${work.context || "(none stated)"}`,
		`Scope:\n${work.scope}`,
		renderWorkList("Acceptance criteria", work.acceptanceCriteria),
		renderWorkList("Constraints", work.constraints),
		renderWorkList("Plan", work.plan),
		renderWorkList("Validation", work.validation),
		renderCostBudget(work),
	];
	return sections.map((section) => theme.fg("muted", section)).join("\n");
}

function renderCostBudget(work: KhalaWork): string {
	if (work.costBudget === undefined) {
		return "Cost budget: (global configuration)";
	}
	const values: string[] = [];
	if (work.costBudget.conclaveMaxCostUsdPerTurn !== undefined) {
		values.push(`Conclave max USD/turn: ${work.costBudget.conclaveMaxCostUsdPerTurn}`);
	}
	if (work.costBudget.executorMaxCostUsdPerTurn !== undefined) {
		values.push(`Executor max USD/turn: ${work.costBudget.executorMaxCostUsdPerTurn}`);
	}
	return `Cost budget:\n${values.join("\\n")}`;
}

function renderWorkList(label: string, values: readonly string[]): string {
	let body = "(none stated)";
	if (values.length > 0) {
		body = values.map((value) => `- ${value}`).join("\n");
	}
	return `${label}:\n${body}`;
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
