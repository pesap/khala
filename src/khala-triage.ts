import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { KhalaEntryType } from "./khala-entry-types.js";

const ARGUMENT_TOKEN_PATTERN = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
const ESCAPED_QUOTE_PATTERN = /\\(["'\\])/g;

type KhalaTriageArguments = Readonly<{
	target?: string | undefined;
	approve: boolean;
	extraInstruction?: string | undefined;
	error?: string | undefined;
}>;

type TriagePromptOptions = Readonly<{
	target?: string | undefined;
	approve: boolean;
	extraInstruction?: string | undefined;
}>;

function tokenizeArguments(value: string): string[] {
	return [...value.matchAll(ARGUMENT_TOKEN_PATTERN)].map((match) => {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		return token.replace(ESCAPED_QUOTE_PATTERN, "$1");
	});
}

function readExtraInstruction(tokens: readonly string[]): { value?: string; skipIndex?: number; error?: string } {
	const separateIndex = tokens.indexOf("--extra");
	if (separateIndex >= 0) {
		const value = tokens[separateIndex + 1];
		if (value === undefined || value.trim().length === 0) {
			return { error: "Missing value for --extra" };
		}
		return { value, skipIndex: separateIndex + 1 };
	}

	const inlineToken = tokens.find((token) => token.startsWith("--extra="));
	if (inlineToken !== undefined) {
		const value = inlineToken.slice("--extra=".length).trim();
		if (value.length === 0) {
			return { error: "Missing value for --extra" };
		}
		return { value };
	}
	return {};
}

function parseKhalaTriageArgs(args: string | undefined): KhalaTriageArguments {
	if (!args?.trim()) {
		return { approve: false };
	}

	const tokens = tokenizeArguments(args.trim());
	const approve = tokens.includes("--approve");
	const extra = readExtraInstruction(tokens);
	if (extra.error !== undefined) {
		return { approve, error: extra.error };
	}
	const targetParts = tokens.filter((token, index) => {
		if (token === "--approve" || token === "--extra" || token.startsWith("--extra=")) {
			return false;
		}
		return index !== extra.skipIndex;
	});
	let target: string | undefined;
	if (targetParts.length > 0) {
		target = targetParts.join(" ");
	}
	return { approve, target, extraInstruction: extra.value };
}

function quotePromptTemplateArgument(value: string): string {
	if (value.includes("'") && value.includes('"')) {
		throw new Error("The triage target or focus cannot contain both single and double quotes.");
	}
	if (!value.includes("'")) {
		return `'${value}'`;
	}
	return `"${value}"`;
}

function buildKhalaTriageTemplateInvocation(options: TriagePromptOptions): string {
	const target = quotePromptTemplateArgument(options.target ?? "");
	let approvalMode = "confirm";
	if (options.approve) {
		approvalMode = "approve";
	}
	let invocation = `/khala-triage-prompt ${target} ${approvalMode}`;
	if (options.extraInstruction?.trim()) {
		invocation += ` ${quotePromptTemplateArgument(options.extraInstruction.trim())}`;
	}
	return invocation;
}

function runKhalaTriage(pi: ExtensionAPI, args: string | undefined, context: ExtensionCommandContext): void {
	const parsed = parseKhalaTriageArgs(args);
	if (parsed.error !== undefined) {
		context.ui.notify(`${parsed.error}. Usage: /khala-triage [--approve] [--extra "focus"] [issue]`, "warning");
		return;
	}

	let promptInvocation: string;
	try {
		promptInvocation = buildKhalaTriageTemplateInvocation({
			target: parsed.target,
			approve: parsed.approve,
			extraInstruction: parsed.extraInstruction,
		});
	} catch (error) {
		if (error instanceof Error) {
			const { message } = error;
			context.ui.notify(message, "warning");
		} else {
			context.ui.notify("The triage prompt could not be prepared.", "warning");
		}
		return;
	}
	const workId = nanoid();
	pi.appendEntry(KhalaEntryType.work, { status: "draft", workId });
	const targetLabel = parsed.target ?? "current issue/request";
	context.ui.notify(`Starting Khala triage for ${targetLabel}.`, "info");
	pi.sendUserMessage(promptInvocation);
}

function registerKhalaTriage(pi: ExtensionAPI): void {
	const handler = (args: string, context: ExtensionCommandContext): Promise<void> => {
		runKhalaTriage(pi, args, context);
		return Promise.resolve();
	};
	pi.registerCommand("khala-triage", {
		description: "Triage an issue into a WorkPacket and send it to the Project Conclave.",
		handler,
	});
	pi.registerCommand("triage", {
		description: "Triage an issue into a Khala WorkPacket.",
		handler,
	});
}

export type { KhalaTriageArguments, TriagePromptOptions };
export {
	buildKhalaTriageTemplateInvocation,
	parseKhalaTriageArgs,
	registerKhalaTriage,
	runKhalaTriage,
	tokenizeArguments,
};
