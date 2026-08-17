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
import { KHALA_SETUP_COMMAND, loadKhalaConfig } from "../../src/khala-config.js";
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
	let config;
	try {
		config = loadKhalaConfig(ctx.cwd, ctx.isProjectTrusted());
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}

	const modelReference = config.conclaveModel.trim();
	const separator = modelReference.indexOf("/");
	if (separator <= 0 || separator === modelReference.length - 1) {
		return {
			reason: `No valid Conclave model is configured. Run \`${KHALA_SETUP_COMMAND}\` to configure Khala.`,
		};
	}

	const provider = modelReference.slice(0, separator);
	const modelId = modelReference.slice(separator + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (model) return { model: model as RewriteModel };

	return { reason: `Configured Conclave model is unavailable: ${modelReference}` };
}

async function callModel(
	text: string,
	model: RewriteModel,
	ctx: ClarifyUi,
	signal?: AbortSignal,
): Promise<string | null> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};

	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		cacheRetention: "none",
	};
	if (auth.headers !== undefined) options.headers = auth.headers;
	if (auth.env !== undefined) options.env = auth.env;
	if (signal !== undefined) options.signal = signal;

	const response = await completeSimple(model, { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] }, options);

	if (response.stopReason === "aborted") {
		return null;
	}

	return extractClarifyText(response);
}

export function extractClarifyText(
	response: Pick<AssistantMessage, "content" | "stopReason" | "errorMessage">,
): string {
	if (response.stopReason === "error") {
		throw new Error(`Clarify model failed: ${response.errorMessage ?? "the provider returned an error"}`);
	}

	const rewritten = response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();

	if (!rewritten) {
		const contentTypes = response.content.map((content) => content.type).join(", ") || "none";
		throw new Error(`Clarify returned no text (stop reason: ${response.stopReason}; content blocks: ${contentTypes}).`);
	}

	return rewritten;
}

async function rewritePrompt(raw: string, ctx: ClarifyUi): Promise<ClarifyOutcome> {
	const text = raw.trim();
	if (!text) {
		return { result: "invalid", reason: USAGE };
	}

	const resolved = resolveRewriteModel(ctx);
	if ("reason" in resolved) {
		return { result: "unavailable", reason: resolved.reason };
	}
	const model = resolved.model;

	// Interactive TUI can show a loader. Other hosts fall through to a plain call.
	if (ctx.mode === "tui" && ctx.hasUI) {
		const loaded = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Clarifying with ${model.provider}/${model.id}...`);
			loader.onAbort = () => done(null);

			const run = async () => {
				try {
					const result = await callModel(text, model, ctx, loader.signal);
					done(result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					done(`error:${message}`);
				}
			};

			void run();
			return loader;
		});
		if (loaded !== undefined && loaded !== null) {
			if (loaded.startsWith("error:")) {
				return { result: "failure", reason: loaded.slice("error:".length) };
			}
			return { result: "ready", text: loaded };
		}
		return { result: "cancelled" };
	}

	try {
		const rewritten = await callModel(text, model, ctx);
		if (rewritten === null) {
			return { result: "cancelled" };
		}
		return { result: "ready", text: rewritten };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { result: "failure", reason: message };
	}
}

// One boundary maps every clarify outcome to UI text.
function applyClarifyOutcome(outcome: ClarifyOutcome, ctx: ClarifyUi): void {
	if (outcome.result === "ready") {
		if (ctx.hasUI && typeof ctx.ui.setEditorText === "function") {
			ctx.ui.setEditorText(outcome.text);
			ctx.ui.notify("Rewrite ready. Edit if needed, then send.", "info");
			return;
		}
		ctx.ui.notify(outcome.text, "info");
		return;
	}
	if (!ctx.hasUI) {
		return;
	}
	if (outcome.result === "cancelled") {
		ctx.ui.notify("Cancelled", "info");
		return;
	}
	if (outcome.result === "invalid") {
		ctx.ui.notify(outcome.reason, "warning");
		return;
	}
	ctx.ui.notify(outcome.reason, "error");
}

export type { ClarifyOutcome };
export { USAGE };
export { applyClarifyOutcome };
// biome-ignore lint/performance/noBarrelFile: The default export remains the extension entry; named helpers stay beside it.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("clarify", {
		description: "Rewrite a rough idea into a precise technical prompt (result goes in the editor)",
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
			const fromEditor = ctx.hasUI && typeof ctx.ui.getEditorText === "function" ? ctx.ui.getEditorText().trim() : "";
			const source = fromArgs || fromEditor;

			if (!source) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}

			await applyClarifyOutcome(await rewritePrompt(source, ui), ui);
		},
	});

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
