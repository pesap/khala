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

import {
	type AssistantMessage,
	completeSimple,
	type SimpleStreamOptions,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

type ClarifyUi = {
	hasUI: boolean;
	mode: string;
	modelRegistry: ExtensionContext["modelRegistry"];
	ui: ExtensionContext["ui"];
	cwd: string;
	isProjectTrusted: () => boolean;
};

// The rewrite flow reports one explicit outcome; UI text is derived only in applyClarifyOutcome.
type ClarifyOutcome =
	| { result: "ready"; text: string }
	| { result: "cancelled" }
	| { result: "invalid"; reason: string }
	| { result: "unavailable"; reason: string }
	| { result: "failure"; reason: string };

type RewriteModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

function resolveRewriteModel(ctx: ClarifyUi): { model: RewriteModel } | { reason: string } {
	const config = readClarifyConfig(ctx);
	if ("reason" in config) return config;
	const reference = splitModelReference(config.conclaveModel);
	if (reference === undefined)
		return { reason: "No valid Conclave model is configured. Open /khala and choose Role settings." };
	const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
	if (model === undefined) return { reason: `Configured Conclave model is unavailable: ${config.conclaveModel}` };
	// SAFETY: modelRegistry.find returns the configured model shape used by completeSimple.
	return { model: model as RewriteModel };
}

function readClarifyConfig(ctx: ClarifyUi): ReturnType<typeof loadConfig> | { reason: string } {
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

// oxlint-disable-next-line complexity
async function callModel(
	text: string,
	model: RewriteModel,
	ctx: ClarifyUi,
	signal?: AbortSignal,
): Promise<string | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
	const options = clarifyStreamOptions({ ...auth, apiKey: auth.apiKey }, signal);
	const response = await completeSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, options);

	if (response.stopReason === "aborted") {
		return null;
	}

	return extractClarifyText(response);
}

type ClarifyAuth = Awaited<ReturnType<ClarifyUi["modelRegistry"]["getApiKeyAndHeaders"]>>;
type ClarifyAuthWithKey = Extract<ClarifyAuth, { ok: true }> & { apiKey: string };

// oxlint-disable-next-line complexity
function clarifyStreamOptions(auth: ClarifyAuthWithKey, signal: AbortSignal | undefined): SimpleStreamOptions {
	const options: SimpleStreamOptions = { apiKey: auth.apiKey, cacheRetention: "none" };
	if (auth.ok && auth.headers !== undefined) options.headers = auth.headers;
	if (auth.ok && auth.env !== undefined) options.env = auth.env;
	if (signal !== undefined) options.signal = signal;
	return options;
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

// oxlint-disable-next-line complexity
async function rewritePrompt(raw: string, ctx: ClarifyUi): Promise<ClarifyOutcome> {
	const text = raw.trim();
	if (text.length === 0) return { result: "invalid", reason: USAGE };
	const resolved = resolveRewriteModel(ctx);
	if ("reason" in resolved) return { result: "unavailable", reason: resolved.reason };
	return ctx.mode === "tui" && ctx.hasUI
		? rewriteWithLoader(text, resolved.model, ctx)
		: rewriteDirect(text, resolved.model, ctx);
}

async function rewriteWithLoader(text: string, model: RewriteModel, ctx: ClarifyUi): Promise<ClarifyOutcome> {
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

async function rewriteDirect(text: string, model: RewriteModel, ctx: ClarifyUi): Promise<ClarifyOutcome> {
	try {
		const rewritten = await callModel(text, model, ctx);
		return rewritten === null ? { result: "cancelled" } : { result: "ready", text: rewritten };
	} catch (error) {
		return { result: "failure", reason: error instanceof Error ? error.message : String(error) };
	}
}

// One boundary maps every clarify outcome to UI text.
function applyClarifyOutcome(outcome: ClarifyOutcome, ctx: ClarifyUi): void {
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

function applyReadyOutcome(text: string, ctx: ClarifyUi): void {
	if (ctx.hasUI) {
		ctx.ui.setEditorText?.(text);
		ctx.ui.notify("Rewrite ready. Edit if needed, then send.", "info");
		return;
	}
	ctx.ui.notify(text, "info");
}

export type { ClarifyOutcome };
export { applyClarifyOutcome, USAGE };
export default function (pi: ExtensionAPI) {
	pi.registerCommand("clarify", {
		description: "Rewrite a rough idea into a precise technical prompt (result goes in the editor)",
		// oxlint-disable-next-line complexity
		handler: async (args, ctx) => {
			const rawArgs = (args ?? "").trim();
			const ui: ClarifyUi = {
				hasUI: ctx.hasUI,
				mode: ctx.mode,
				modelRegistry: ctx.modelRegistry,
				ui: ctx.ui,
				cwd: ctx.cwd,
				isProjectTrusted: ctx.isProjectTrusted,
			};

			const fromArgs = rawArgs;
			const fromEditor = ctx.hasUI ? (ctx.ui.getEditorText?.()?.trim() ?? "") : "";
			const source = fromArgs || fromEditor;

			if (!source) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			await applyClarifyOutcome(await rewritePrompt(source, ui), ui);
		},
	});

	// oxlint-disable-next-line complexity
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text;
		if (!hasClarifyMarker(text)) {
			return { action: "continue" };
		}

		const rough = stripClarifyMarker(text);
		if (!rough) {
			if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
			return { action: "handled" };
		}

		const ui: ClarifyUi = {
			hasUI: ctx.hasUI,
			mode: ctx.mode,
			modelRegistry: ctx.modelRegistry,
			ui: ctx.ui,
			cwd: ctx.cwd,
			isProjectTrusted: ctx.isProjectTrusted,
		};

		await applyClarifyOutcome(await rewritePrompt(rough, ui), ui);
		return { action: "handled" };
	});
}
