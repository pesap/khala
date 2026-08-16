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

type RewriteModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

function resolveRewriteModel(ctx: ClarifyUi): RewriteModel | null {
	let config;
	try {
		config = loadKhalaConfig(ctx.cwd, ctx.isProjectTrusted());
	} catch (error) {
		if (ctx.hasUI) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return null;
	}

	const modelReference = config.conclaveModel.trim();
	const separator = modelReference.indexOf("/");
	if (separator <= 0 || separator === modelReference.length - 1) {
		if (ctx.hasUI) {
			ctx.ui.notify(
				`No valid Conclave model is configured. Run \`${KHALA_SETUP_COMMAND}\` to configure Khala.`,
				"error",
			);
		}
		return null;
	}

	const provider = modelReference.slice(0, separator);
	const modelId = modelReference.slice(separator + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (model) return model as RewriteModel;

	if (ctx.hasUI) {
		ctx.ui.notify(`Configured Conclave model is unavailable: ${modelReference}`, "error");
	}
	return null;
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

async function rewritePrompt(raw: string, ctx: ClarifyUi): Promise<string | null> {
	const text = raw.trim();
	if (!text) {
		if (ctx.hasUI) ctx.ui.notify(USAGE, "warning");
		return null;
	}

	const model = resolveRewriteModel(ctx);
	if (!model) return null;

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
					ctx.ui.notify(message, "error");
					done(null);
				}
			};

			void run();
			return loader;
		});
		if (loaded !== undefined) return loaded;
	}

	try {
		return await callModel(text, model, ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		return null;
	}
}

async function putRewriteInEditor(raw: string, ctx: ClarifyUi): Promise<void> {
	const rewritten = await rewritePrompt(raw, ctx);
	if (rewritten === null) {
		if (ctx.hasUI) ctx.ui.notify("Cancelled", "info");
		return;
	}

	if (ctx.hasUI && typeof ctx.ui.setEditorText === "function") {
		ctx.ui.setEditorText(rewritten);
		ctx.ui.notify("Rewrite ready. Edit if needed, then send.", "info");
		return;
	}

	ctx.ui.notify(rewritten, "info");
}

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

			await putRewriteInEditor(source, ui);
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

		await putRewriteInEditor(rough, ui);
		return { action: "handled" };
	});
}
