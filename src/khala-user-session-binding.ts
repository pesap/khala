// Causal User-session binding for tools that record User intent. The tool call
// is matched by its exact toolCallId, then session-entry parent links are
// walked back through assistant and tool-result entries to the causal source.
// Only a normal persisted User message authorizes; custom messages, stale
// earlier User entries, missing or ambiguous tool calls, broken parents, and
// cycles are rejected.
import { createHash } from "node:crypto";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type UserSourceBinding = Readonly<{ sessionId: string; entryId: string; contentSha256: string }>;

function resolveUserSourceBinding(context: ExtensionContext, toolCallId: string): UserSourceBinding {
	// Only the current session branch may authorize: a tool call id present in a
	// side branch is not this turn's causal source.
	const entries = context.sessionManager.getBranch();
	const byId = new Map<string, SessionEntry>();
	const toolCallIndexes: number[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry !== undefined) {
			byId.set(entry.id, entry);
			if (entry.type === "message" && containsToolCall(entry.message, toolCallId)) {
				toolCallIndexes.push(index);
			}
		}
	}
	if (toolCallIndexes.length === 0) {
		throw new Error("Khala could not find the persisted tool call for this User turn.");
	}
	if (toolCallIndexes.length > 1) {
		throw new Error("The tool call appears in multiple persisted assistant entries.");
	}
	const toolCallEntry = entries[toolCallIndexes[0] as number];
	if (toolCallEntry === undefined) {
		throw new Error("Khala could not resolve the persisted tool call.");
	}
	const userEntry = walkCausalSource(toolCallEntry, byId);
	const { message } = userEntry;
	if (message.role !== "user") {
		throw new Error("Khala could not bind the intent to a normal persisted User turn.");
	}
	return {
		sessionId: context.sessionManager.getSessionId(),
		entryId: userEntry.id,
		contentSha256: messageContentSha256(message.content),
	};
}

function walkCausalSource(
	start: SessionEntry,
	byId: Map<string, SessionEntry>,
): Extract<SessionEntry, { type: "message" }> {
	const visited = new Set<string>();
	let current: SessionEntry = start;
	while (true) {
		if (visited.has(current.id)) {
			throw new Error("The persisted session parent chain contains a cycle.");
		}
		visited.add(current.id);
		let parent: SessionEntry | undefined;
		if (current.parentId !== null) {
			parent = byId.get(current.parentId);
		}
		if (parent === undefined) {
			throw new Error("The persisted User turn has a broken parent chain.");
		}
		if (parent.type === "message" && parent.message.role === "user") {
			return parent;
		}
		if (parent.type === "message" && (parent.message.role === "assistant" || parent.message.role === "toolResult")) {
			current = parent;
		} else {
			throw new Error("Khala could not bind the intent to a normal persisted User turn.");
		}
	}
}

function containsToolCall(message: Readonly<{ role?: unknown; content?: unknown }>, toolCallId: string): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return false;
	}
	const content = message.content as readonly unknown[];
	return content.some(
		(part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "toolCall" &&
			(part as { id?: unknown }).id === toolCallId,
	);
}

function messageContentSha256(content: unknown): string {
	if (typeof content === "string") {
		return sha256(content);
	}
	return sha256(JSON.stringify(content));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export type { UserSourceBinding };
export { messageContentSha256, resolveUserSourceBinding, sha256 };
