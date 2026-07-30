import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KhalaEntryType } from "./khala-entry-types.js";

const KhalaRole = {
	conclave: "conclave",
	executor: "executor",
	observer: "observer",
	maintainer: "maintainer",
	preserver: "preserver",
} as const;
type KhalaRoleValue = (typeof KhalaRole)[keyof typeof KhalaRole];
type RoleDefinition = Readonly<{ fileName: string; description: string }>;

const ROLE_DEFINITIONS: Readonly<Record<KhalaRoleValue, RoleDefinition>> = {
	[KhalaRole.conclave]: {
		fileName: "conclave.md",
		description: "Create a clean session with the Khala Conclave system prompt.",
	},
	[KhalaRole.executor]: {
		fileName: "executor.md",
		description: "Create a clean session with the Khala Executor system prompt.",
	},
	[KhalaRole.observer]: {
		fileName: "observer.md",
		description: "Create a clean session with the Khala Observer system prompt.",
	},
	[KhalaRole.maintainer]: {
		fileName: "maintainer.md",
		description: "Create a clean session with the Khala Maintainer system prompt.",
	},
	[KhalaRole.preserver]: {
		fileName: "preserver.md",
		description: "Create a clean session with the Khala Preserver system prompt.",
	},
};
const ROLE_NAMES = Object.values(KhalaRole);

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Role resolution scans persisted markers from newest to oldest.
function readSessionRole(context: ExtensionContext): KhalaRoleValue | null {
	const entries = context.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom") {
			if (entry.customType === KhalaEntryType.observer) {
				return KhalaRole.observer;
			}
			if (entry.customType === KhalaEntryType.executor) {
				return KhalaRole.executor;
			}
			if (entry.customType === KhalaEntryType.role) {
				if (isRoleData(entry.data)) {
					return entry.data.role;
				}
				return null;
			}
			if (entry.customType === KhalaEntryType.conclave) {
				return KhalaRole.conclave;
			}
		}
	}
	return null;
}

function isRoleData(data: unknown): data is { role: KhalaRoleValue } {
	if (typeof data !== "object" || data === null || !("role" in data)) {
		return false;
	}
	const { role } = data;
	if (typeof role !== "string") {
		return false;
	}
	return ROLE_NAMES.includes(role as KhalaRoleValue);
}

function readRolePrompt(packageRoot: string, role: KhalaRoleValue): string {
	return readFileSync(join(packageRoot, "system-prompts", ROLE_DEFINITIONS[role].fileName), "utf8").trim();
}

export type { KhalaRoleValue, RoleDefinition };
export { isRoleData, KhalaRole, ROLE_DEFINITIONS, ROLE_NAMES, readRolePrompt, readSessionRole };
