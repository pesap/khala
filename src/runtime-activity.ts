import { stripVTControlCharacters } from "node:util";
import type { JsonObject, JsonValue } from "./model.js";
import type { RuntimeActivityEntry, RuntimeActivitySnapshot, RuntimeActivitySubscription } from "./ports.js";
import { isJsonObject, isText } from "./runtime-lease.js";

const MAX_ENTRIES = 100;
const MAX_TEXT = 4_000;
const MAX_TOOL_FIELD = 128;
const MAX_SUBSCRIBERS = 8;

type MutableMessage = { kind: "message"; text: string; truncated: boolean };

function clean(value: string): string {
	return stripVTControlCharacters(value).replace(/\p{Cc}/gu, (character) =>
		character === "\n" || character === "\t" ? character : "",
	);
}

function wellFormed(value: string): string {
	return value.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

function clip(value: string, limit: number): string {
	const result = value.slice(0, limit);
	const last = result.charCodeAt(result.length - 1);
	return last >= 0xd800 && last <= 0xdbff ? result.slice(0, -1) : result;
}

function shortText(value: JsonValue | undefined): string | undefined {
	if (!isText(value)) return;
	const result = clip(wellFormed(clean(value)).trim(), MAX_TOOL_FIELD);
	return result.length === 0 ? undefined : result;
}

function textDelta(event: JsonObject): string | undefined {
	const update = event["assistantMessageEvent"];
	if (!isJsonObject(update) || update["type"] !== "text_delta") return;
	const value = update["delta"];
	return isText(value) ? value : undefined;
}

function messageText(value: JsonValue | undefined): string | undefined {
	if (!Array.isArray(value)) return;
	return value
		.flatMap((block) => {
			if (!isJsonObject(block) || block["type"] !== "text" || !isText(block["text"])) return [];
			return [block["text"]];
		})
		.join("\n");
}

export class RuntimeActivityLog {
	private readonly entries: RuntimeActivityEntry[] = [];
	private readonly listeners = new Set<Readonly<{ onChange: () => void }>>();
	private current: MutableMessage | undefined;
	private pendingSurrogate = "";
	private deferredForControl = false;
	private inAssistant = false;
	private ended = false;
	private scheduled = false;
	private discarded = 0;

	observe(onChange: () => void): RuntimeActivitySubscription {
		if (this.ended) throw new Error("Runtime activity is no longer attached.");
		if (this.listeners.size >= MAX_SUBSCRIBERS) throw new Error("Runtime activity has too many subscribers.");
		const listener = { onChange };
		this.listeners.add(listener);
		let open = true;
		return {
			snapshot: () => {
				if (!open) throw new Error("Runtime activity subscription is closed.");
				return this.snapshot();
			},
			close: () => {
				open = false;
				this.listeners.delete(listener);
			},
		};
	}

	accept(event: JsonObject): void {
		if (this.ended) return;
		const type = event["type"];
		if (type === "message_start") return this.startMessage(event);
		if (type === "message_update") return this.updateMessage(event);
		this.finishOrTool(type, event);
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.notify();
	}

	private snapshot(): RuntimeActivitySnapshot {
		return {
			state: this.ended ? "ended" : "attached",
			entries: this.entries.map((entry) => ({ ...entry })),
			discarded: this.discarded,
		};
	}

	private finishOrTool(type: JsonValue | undefined, event: JsonObject): void {
		if (type === "message_end") this.endMessage(event);
		else if (type === "tool_execution_start") this.tool(event, "started");
		else if (type === "tool_execution_end") this.tool(event, this.toolEndPhase(event));
	}

	private startMessage(event: JsonObject): void {
		const message = event["message"];
		this.inAssistant = isJsonObject(message) && message["role"] === "assistant";
		this.current = undefined;
		this.pendingSurrogate = "";
		this.deferredForControl = false;
	}

	private updateMessage(event: JsonObject): void {
		if (!this.inAssistant || this.deferredForControl) return;
		const delta = textDelta(event);
		if (delta === undefined) return;
		this.appendStreamingText(delta);
	}

	private appendStreamingText(delta: string): void {
		const control = delta.search(/(?!\n|\t)\p{Cc}/u);
		if (control === -1) return this.appendText(delta);
		// A control sequence can span deltas. Wait for the complete authoritative message.
		this.deferredForControl = true;
		this.appendText(delta.slice(0, control));
	}

	private endMessage(event: JsonObject): void {
		const message = event["message"];
		if (!isJsonObject(message) || message["role"] !== "assistant") return;
		const text = messageText(message["content"]);
		if (text === undefined) return;
		this.finishMessage(text);
	}

	private appendText(text: string): void {
		if (this.current?.truncated === true) return;
		const complete = this.completeDelta(text);
		if (complete.length === 0) return;
		this.appendCompleteText(complete);
	}

	private appendCompleteText(text: string): void {
		const message = this.current ?? this.newMessage();
		this.setMessage(message, message.text + text);
	}

	private completeDelta(text: string): string {
		const value = this.pendingSurrogate + clean(text);
		const last = value.charCodeAt(value.length - 1);
		const pending = last >= 0xd800 && last <= 0xdbff;
		this.pendingSurrogate = pending ? value.slice(-1) : "";
		return wellFormed(pending ? value.slice(0, -1) : value);
	}

	private finishMessage(text: string): void {
		const value = wellFormed(clean(text)).trim();
		if (this.current === undefined && value.length > 0) this.current = this.newMessage();
		if (this.current !== undefined) this.setMessage(this.current, value);
		this.current = undefined;
		this.pendingSurrogate = "";
		this.deferredForControl = false;
		this.inAssistant = false;
	}

	private newMessage(): MutableMessage {
		const message: MutableMessage = { kind: "message", text: "", truncated: false };
		this.append(message);
		this.current = message;
		return message;
	}

	private setMessage(message: MutableMessage, value: string): void {
		message.text = clip(value, MAX_TEXT);
		message.truncated = message.text.length < value.length;
		this.notify();
	}

	private tool(event: JsonObject, phase: Extract<RuntimeActivityEntry, { kind: "tool" }>["phase"]): void {
		const callId = shortText(event["toolCallId"]);
		const name = shortText(event["toolName"]);
		if (callId === undefined || name === undefined) return;
		this.append({ kind: "tool", callId, name, phase });
	}

	private toolEndPhase(event: JsonObject): Extract<RuntimeActivityEntry, { kind: "tool" }>["phase"] {
		if (event["isError"] === true) return "failed";
		return event["isError"] === false ? "succeeded" : "finished";
	}

	private append(entry: RuntimeActivityEntry): void {
		if (this.entries.length === MAX_ENTRIES) {
			const removed = this.entries.shift();
			if (removed === this.current) this.current = undefined;
			this.discarded += 1;
		}
		this.entries.push(entry);
		this.notify();
	}

	private notify(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			// Re-subscription during a callback must not extend this delivery indefinitely.
			const pending = Array.from(this.listeners);
			for (const listener of pending) {
				if (this.listeners.has(listener)) this.notifyListener(listener.onChange);
			}
			if (this.ended) this.listeners.clear();
		});
	}

	private notifyListener(listener: () => void): void {
		try {
			void Promise.resolve(listener()).catch(() => undefined);
		} catch {
			// Observation must not interrupt a governed child or its usage accounting.
		}
	}
}
