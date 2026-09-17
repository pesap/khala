import { existsSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isTextValue } from "./extension-results.js";
import type { Actor, CommandMeta, JsonValue } from "./model.js";
import { ApplicationError } from "./service.js";

export const ROLE_FLAG = "khala-role";
type SessionRole = "user" | "conclave" | "observer" | "executor" | "oracle";
type RestrictedSessionRole = Exclude<SessionRole, "user">;
const RESTRICTED_ROLE_TOOLS = {
	conclave: new Set(["khala_read_archive", "khala_perform_action", "khala_run_oracle", "khala_inspect_runtime"]),
	executor: new Set([
		"read",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"khala_read_archive",
		"khala_record_signal",
		"khala_perform_action",
	]),
	observer: new Set(["read", "grep", "find", "ls", "khala_read_archive", "khala_record_assessment"]),
	oracle: new Set(),
} satisfies Record<RestrictedSessionRole, ReadonlySet<string>>;
export const rolePromptFiles = {
	conclave: "conclave.md",
	observer: "observer.md",
	executor: "executor.md",
	oracle: "oracle.md",
} as const;
const roleToken = readRoleToken();
const SESSION_ROLES = new Map<string, "conclave" | "observer" | "executor" | "oracle">([
	["conclave", "conclave"],
	["observer", "observer"],
	["executor", "executor"],
	["oracle", "oracle"],
]);

export function sessionRole(pi: ExtensionAPI): SessionRole {
	const value = pi.getFlag(ROLE_FLAG);
	return isSessionRole(value) ? value : "user";
}

export function restrictedToolViolation(pi: ExtensionAPI, event: ToolCallEvent): string | undefined {
	const role = sessionRole(pi);
	const allowed = roleToolNames(role);
	if (allowed === undefined) return;
	if (!allowed.has(event.toolName)) return `The ${role} session cannot use the ${event.toolName} tool.`;
	return restrictedPathViolation(role, event);
}

function restrictedPathViolation(role: SessionRole, event: ToolCallEvent): string | undefined {
	return role === "executor" || role === "observer" ? executorToolViolation(event) : undefined;
}

function isSessionRole(value: string | boolean | undefined): value is "conclave" | "observer" | "executor" | "oracle" {
	return value !== undefined && SESSION_ROLES.get(String(value)) === value;
}

export function requireSessionRole(pi: ExtensionAPI, expected: Exclude<Actor, "monitor" | "system">): void {
	const actual = sessionRole(pi);
	if (actual !== expected)
		throw new ApplicationError({
			code: "forbidden",
			summary: `The ${expected} tool requires a ${expected} session.`,
			retryable: false,
			remediation: "Use the tool from its bound Khala role session.",
			evidenceRefs: [],
		});
}

export function setRoleTools(pi: ExtensionAPI): void {
	const allowed = roleToolNames(sessionRole(pi));
	if (allowed === undefined) return;
	pi.setActiveTools(pi.getActiveTools().filter((name) => allowed.has(name)));
}

function roleToolNames(role: SessionRole): ReadonlySet<string> | undefined {
	return role === "user" ? undefined : RESTRICTED_ROLE_TOOLS[role];
}

function executorToolViolation(event: ToolCallEvent): string | undefined {
	const path = executorToolPath(event);
	if (path === null) return `The ${event.toolName} tool requires a path.`;
	return path === undefined ? undefined : pathViolation(path, event.toolName === "write" || event.toolName === "edit");
}

function pathViolation(path: string, write: boolean): string | undefined {
	if (!executorPathInsideSandbox(path)) return `The Mission does not permit access to ${path}.`;
	if (write && !executorPathAllowed(path)) return `The Mission does not permit writes to ${path}.`;
	return;
}

function executorToolPath(event: ToolCallEvent): string | null | undefined {
	const filePath = fileToolPath(event);
	return filePath === undefined ? searchToolPath(event) : filePath;
}

type FileToolCallEvent = Extract<ToolCallEvent, { toolName: "read" | "write" | "edit" }>;

function fileToolPath(event: ToolCallEvent): string | null | undefined {
	if (!isFileTool(event)) return;
	// SAFETY: Pi's file tool schemas supply a path string; the assertion narrows the external tool event at this boundary.
	return textValue(event.input.path as JsonValue) ?? null;
}

function isFileTool(event: ToolCallEvent): event is FileToolCallEvent {
	return ["read", "write", "edit"].includes(event.toolName);
}

type SearchToolCallEvent = Extract<ToolCallEvent, { toolName: "grep" | "find" | "ls" }>;

function searchToolPath(event: ToolCallEvent): string | undefined {
	if (!isSearchTool(event)) return;
	// SAFETY: Pi's search/list schemas supply an optional path string; the assertion narrows the external tool event at this boundary.
	return textValue(event.input.path as JsonValue) ?? ".";
}

function isSearchTool(event: ToolCallEvent): event is SearchToolCallEvent {
	return event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls";
}

function textValue(value: JsonValue | undefined): string | undefined {
	return value === String(value) ? String(value) : undefined;
}

function executorPathInsideSandbox(path: string): boolean {
	const scope = executorPathScope();
	return scope === null ? false : pathInsideRoot(path, scope.root);
}

function executorPathAllowed(path: string): boolean {
	const scope = executorPathScope();
	return scope === null ? false : pathMatchesScope(path, scope);
}

function pathMatchesScope(path: string, scope: Readonly<{ root: string; allowedPaths: readonly string[] }>): boolean {
	const rootRelative = relativeToRoot(path, scope.root);
	return rootRelative !== undefined && scope.allowedPaths.some((allowed) => matchesAllowedPath(rootRelative, allowed));
}

function pathInsideRoot(path: string, root: string): boolean {
	return relativeToRoot(path, root) !== undefined;
}

function relativeToRoot(path: string, root: string): string | undefined {
	const resolvedRoot = realPath(root);
	const candidate = resolveExistingPath(resolveExecutorPath(root, path));
	if (resolvedRoot === undefined || candidate === undefined) return;
	const rootRelative = relative(resolvedRoot, candidate).replace(/\\/g, "/");
	return isInsideRoot(rootRelative) ? rootRelative : undefined;
}

function resolveExistingPath(path: string): string | undefined {
	let current = path;
	const suffix: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return;
		suffix.unshift(current.slice(parent.length + 1));
		current = parent;
	}
	const resolved = realPath(current);
	return resolved === undefined ? undefined : resolve(resolved, ...suffix);
}

function realPath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function executorPathScope(): Readonly<{ root: string; allowedPaths: readonly string[] }> | null {
	const root = process.env["KHALA_SANDBOX_ROOT"];
	const encodedPaths = process.env["KHALA_ALLOWED_PATHS"];
	if (root === undefined) return null;
	if (encodedPaths === undefined) return null;
	const allowedPaths = parseAllowedPaths(encodedPaths);
	return allowedPaths === undefined ? null : { root, allowedPaths };
}

function resolveExecutorPath(root: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(root, path);
}

function parseAllowedPaths(encoded: string): readonly string[] | undefined {
	try {
		// SAFETY: isTextValue verifies every JSON array member before narrowing it to a string.
		const parsed = JSON.parse(encoded) as JsonValue;
		return Array.isArray(parsed) && parsed.every(isTextValue) ? parsed.filter(isTextValue) : undefined;
	} catch {
		return undefined;
	}
}

function isInsideRoot(rootRelative: string): boolean {
	return !rootRelative.startsWith("..") && !isAbsolute(rootRelative);
}

function matchesAllowedPath(rootRelative: string, allowed: string): boolean {
	const normalized = allowed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	return normalized === "." || rootRelative === normalized || rootRelative.startsWith(`${normalized}/`);
}

function readRoleToken(): string | undefined {
	const path = process.env["KHALA_ROLE_TOKEN_FILE"];
	if (path === undefined) return;
	try {
		const token = readFileSync(path, "utf8").trim();
		removeRoleTokenFile(path);
		return token.length === 0 ? undefined : token;
	} catch {
		return;
	}
}

function removeRoleTokenFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// The runtime removes the capability file during child startup cleanup.
	}
}

export function meta(actor: Actor, commandId: string, expectedWorkRevision: number): CommandMeta {
	return {
		actor,
		commandId,
		expectedWorkRevision,
		roleToken: actor === "user" ? undefined : roleToken,
		roleNonce: actor === "user" ? undefined : process.env["KHALA_ROLE_NONCE"],
		boundWorkId: process.env["KHALA_BOUND_WORK_ID"],
		boundExecutionId: process.env["KHALA_BOUND_EXECUTION_ID"],
		schemaVersion: 1,
	};
}
