/**
 * pi-clarify — rewrite plain-language prompts into precise technical prompts.
 *
 * Triggers:
 *   /clarify <rough idea>
 *   /clarify                         # rewrite current editor text
 *   ... -clarify                     # marker anywhere in a message
 *
 * The rewrite uses the configured Khala Conclave model for the current project.
 */

import { type Api, type AssistantMessage, type ModelsApiStreamOptions, type UserMessage } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { hasClarifyMarker, stripClarifyMarker } from "./marker.js";

const USAGE = "Usage: /clarify <idea> | /clarify | add -clarify anywhere in the message";

const SYSTEM_PROMPT = `You rewrite rough, plain-language user prompts into clear, precise prompts for a coding agent.

Your job is terminology compression and clarity, not invention.

Rules:
1. Keep the user's intent exactly. Do not add features, constraints, stack choices, or preferences they did not state.
2. When a well-known technical term matches what the user described, use that term instead of the long description.
   Examples of the kind of compression wanted:
   - "remember old card positions, measure new ones, animate between them" → "FLIP animation"
   - "thumbnail grows into the large image on the next screen so it feels like the same image" → "shared-element transition"
   - "one small part working end-to-end from UI through backend and database" → "vertical slice"
   - "show the new state right away, then fix it if the server fails" → "optimistic update"
   - "wait until the user stops typing before searching" → "debounce the search input"
   Apply the same idea in any domain: use the standard name for the pattern, algorithm, UX move, architecture choice, protocol, or process the user is describing.
3. Prefer short, exact terms over long explanations. If a term is right, use it.
4. Preserve all concrete details: product names, file names, paths, numbers, constraints, UI copy, error text, and acceptance criteria.
5. Keep the rewrite as a ready-to-send user prompt. Do not wrap it in quotes. Do not add a preamble like "Here is the rewritten prompt".
6. Use the same language the user wrote in (English stays English, Italian stays Italian, etc.).
7. If the original is already precise, make only light cleanup. Do not invent jargon or force terms that do not fit.
8. Structure multi-part asks with short bullets or numbered steps when that makes the ask clearer.
9. Do not answer the request. Only rewrite the prompt.
10. Output only the rewritten prompt text.`;

type ClarifyContext = Pick<
	ExtensionContext,
	"hasUI" | "mode" | "modelRegistry" | "ui" | "cwd" | "isProjectTrusted" | "signal"
>;

// The rewrite flow reports one explicit outcome; UI text is derived only in applyClarifyOutcome.
type ClarifyOutcome =
	| { result: "ready"; text: string }
	| { result: "cancelled" }
	| { result: "invalid"; reason: string }
	| { result: "unavailable"; reason: string }
	| { result: "failure"; reason: string };

type RewriteModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

function resolveRewriteModel(ctx: ClarifyContext): { model: RewriteModel } | { reason: string } {
	const config = readClarifyConfig(ctx);
	if ("reason" in config) return config;
	const reference = splitModelReference(config.conclaveModel);
	if (reference === undefined)
		return { reason: "No valid Conclave model is configured. Open /khala and choose Role settings." };
	const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
	if (model === undefined) return { reason: `Configured Conclave model is unavailable: ${config.conclaveModel}` };
	return { model };
}

function readClarifyConfig(ctx: ClarifyContext): ReturnType<typeof loadConfig> | { reason: string } {
	try {
		return loadConfig(ctx.cwd, ctx.isProjectTrusted(), false);
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}
}

function splitModelReference(value: string): { provider: string; modelId: string } | undefined {
	const reference = value.trim();
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator === reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}
async function callModel(
	text: string,
	model: RewriteModel,
	ctx: ClarifyContext,
	signal?: AbortSignal,
): Promise<string | null> {
	const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	const options: ModelsApiStreamOptions<Api> = { cacheRetention: "none" };
	if (signal !== undefined) options.signal = signal;
	const response = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		options,
	);
	return response.stopReason === "aborted" ? null : extractClarifyText(response);
}

export function extractClarifyText(
	response: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">,
): string {
	if (response.stopReason === "error")
		throw new Error(`Clarify model failed: ${response.errorMessage ?? "the provider returned an error"}`);
	const rewritten = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
	if (rewritten.length > 0) return rewritten;
	throw new Error(
		`Clarify returned no text (stop reason: ${response.stopReason}; content blocks: ${contentTypes(response)}).`,
	);
}

function contentTypes(response: Pick<AssistantMessage, "content">): string {
	return response.content.map((content) => content.type).join(", ") || "none";
}
async function rewritePrompt(raw: string, ctx: ClarifyContext): Promise<ClarifyOutcome> {
	const text = raw.trim();
	if (text.length === 0) return { result: "invalid", reason: USAGE };
	const resolved = resolveRewriteModel(ctx);
	if ("reason" in resolved) return { result: "unavailable", reason: resolved.reason };
	return rewriteResolvedPrompt(text, resolved.model, ctx);
}

function rewriteResolvedPrompt(text: string, model: RewriteModel, ctx: ClarifyContext): Promise<ClarifyOutcome> {
	if (ctx.mode === "tui" && ctx.hasUI) return rewriteWithLoader(text, model, ctx);
	return rewriteDirect(text, model, ctx);
}

async function rewriteWithLoader(text: string, model: RewriteModel, ctx: ClarifyContext): Promise<ClarifyOutcome> {
	const loaded = await ctx.ui.custom<ClarifyOutcome | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Clarifying with ${model.provider}/${model.id}...`);
		loader.onAbort = () => done({ result: "cancelled" });
		void callModel(text, model, ctx, loader.signal)
			.then((result) => done(result === null ? { result: "cancelled" } : { result: "ready", text: result }))
			.catch((error) => done({ result: "failure", reason: error instanceof Error ? error.message : String(error) }));
		return loader;
	});
	return loaded ?? { result: "cancelled" };
}

async function rewriteDirect(text: string, model: RewriteModel, ctx: ClarifyContext): Promise<ClarifyOutcome> {
	try {
		const rewritten = await callModel(text, model, ctx, ctx.signal);
		return rewritten === null ? { result: "cancelled" } : { result: "ready", text: rewritten };
	} catch (error) {
		return { result: "failure", reason: error instanceof Error ? error.message : String(error) };
	}
}

// One boundary maps every clarify outcome to UI text.
function applyClarifyOutcome(outcome: ClarifyOutcome, ctx: ClarifyContext): void {
	if (outcome.result === "ready") {
		applyReadyOutcome(outcome.text, ctx);
		return;
	}
	if (!ctx.hasUI) return;
	ctx.ui.notify(outcome.result === "cancelled" ? "Cancelled" : outcome.reason, clarifyOutcomeLevel(outcome));
}

function clarifyOutcomeLevel(outcome: Exclude<ClarifyOutcome, { result: "ready" }>): "info" | "warning" | "error" {
	if (outcome.result === "invalid") return "warning";
	return outcome.result === "failure" ? "error" : "info";
}

function applyReadyOutcome(text: string, ctx: ClarifyContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setEditorText(text);
	ctx.ui.notify("Rewrite ready. Edit if needed, then send.", "info");
}

function clarifyCommandSource(args: string | undefined, ui: ClarifyContext): string {
	const fromArgs = args?.trim() ?? "";
	return fromArgs.length > 0 ? fromArgs : clarifyEditorText(ui);
}

function clarifyEditorText(ui: ClarifyContext): string {
	return ui.hasUI ? ui.ui.getEditorText().trim() : "";
}

async function handleClarifyCommand(args: string | undefined, ctx: ClarifyContext): Promise<void> {
	if (!ctx.hasUI) throw new Error("The /clarify command requires a UI-capable Pi session.");
	const source = clarifyCommandSource(args, ctx);
	if (!source) {
		ctx.ui.notify(USAGE, "warning");
		return;
	}
	await applyClarifyOutcome(await rewritePrompt(source, ctx), ctx);
}

function shouldClarifyInput(event: Pick<InputEvent, "source" | "text">, ctx: ClarifyContext): boolean {
	return ctx.hasUI && event.source !== "extension" && hasClarifyMarker(event.text);
}

async function handleClarifyInput(
	event: Pick<InputEvent, "source" | "text">,
	ctx: ClarifyContext,
): Promise<{ action: "continue" | "handled" }> {
	if (!shouldClarifyInput(event, ctx)) return { action: "continue" };
	const rough = stripClarifyMarker(event.text);
	if (!rough) {
		ctx.ui.notify(USAGE, "warning");
		return { action: "handled" };
	}
	await applyClarifyOutcome(await rewritePrompt(rough, ctx), ctx);
	return { action: "handled" };
}

export type { ClarifyOutcome };
export { applyClarifyOutcome, USAGE };
export default function (pi: ExtensionAPI) {
	pi.registerCommand("clarify", {
		description: "Rewrite a rough idea into a precise technical prompt (result goes in the editor)",
		handler: async (args, ctx) => handleClarifyCommand(args, ctx),
	});
	pi.on("input", async (event, ctx) => handleClarifyInput(event, ctx));
}
