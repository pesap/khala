import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import type { GovernedRole, JsonObject, JsonValue, RoleSetting } from "./model.js";

export type KhalaConfig = Readonly<{
	archiveRoot: string;
	worktreeRoot: string;
	worktreeBranchPrefix: string;
	targetBranch: string;
	maxConcurrentExecutions: number;
	defaultWorkTokens: number;
	piCommand: readonly string[];
	conclaveModel: string;
	conclaveThinking: string;
	executorModel: string;
	executorThinking: string;
	oracleModel: string;
	oracleThinking: string;
	observerModel: string;
	observerThinking: string;
	keybindings: Readonly<{ roleSettings: string; comments: string; refresh: string; help: string; history: string }>;
}>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const DEFAULTS: KhalaConfig = {
	archiveRoot: join(homedir(), ".pi", "agent", "khala"),
	worktreeRoot: join(homedir(), "worktrees", "khala"),
	worktreeBranchPrefix: "khala/",
	targetBranch: "main",
	maxConcurrentExecutions: 2,
	defaultWorkTokens: 20_000,
	piCommand: ["pi"],
	conclaveModel: "",
	conclaveThinking: "medium",
	executorModel: "",
	executorThinking: "high",
	oracleModel: "",
	oracleThinking: "high",
	observerModel: "",
	observerThinking: "medium",
	keybindings: { roleSettings: "r", comments: "c", refresh: "ctrl+r", help: "?", history: "h" },
};

export function loadConfig(projectPath: string, trusted: boolean, requireModels = true): KhalaConfig {
	const globalPath = join(agentDirectory(), "khala.json");
	const projectConfig = trusted ? readConfig(join(projectPath, ".pi", "khala.json")) : undefined;
	const config = apply(apply(DEFAULTS, readConfig(globalPath)), projectConfig);
	if (requireModels) validateRequiredModels(config);
	return config;
}

function validateRequiredModels(config: KhalaConfig): void {
	for (const [field, value] of requiredModels(config)) {
		if (value.trim().length === 0) {
			throw new ConfigError(
				`${field} is required. Open \`/khala\` and configure the role settings before starting governed Work.`,
			);
		}
	}
}

function requiredModels(config: KhalaConfig): readonly (readonly [string, string])[] {
	return [
		["conclaveModel", config.conclaveModel],
		["executorModel", config.executorModel],
		["oracleModel", config.oracleModel],
	];
}

export function archivePath(config: KhalaConfig, projectPath: string): string {
	const key = createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 24);
	return join(config.archiveRoot, `${key}.sqlite`);
}

export function agentDirectory(): string {
	const configured = process.env["PI_CODING_AGENT_DIR"];
	return configured === undefined || configured.trim().length === 0 ? join(homedir(), ".pi", "agent") : configured;
}

export function persistRoleSetting(role: GovernedRole, setting: RoleSetting, value: string): void {
	const normalized = value.trim();
	if (normalized.length === 0) {
		throw new ConfigError(`${role} ${setting} must not be blank.`);
	}
	const directory = agentDirectory();
	const path = join(directory, "khala.json");
	mkdirSync(directory, { recursive: true });
	const lockPath = `${path}.lock`;
	acquireConfigLock(lockPath);
	try {
		const current = readConfig(path) ?? {};
		const next = { ...current, [roleConfigKey(role, setting)]: normalized };
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temporaryPath, path);
		} finally {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// The temporary file was renamed or was never created.
			}
		}
	} finally {
		unlinkSync(lockPath);
	}
}

function acquireConfigLock(path: string): void {
	const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (tryAcquireConfigLock(path)) return;
		removeStaleConfigLock(path);
		Atomics.wait(waitBuffer, 0, 0, 10);
	}
	throw new ConfigError(`Could not acquire the configuration lock at ${path}.`);
}

function tryAcquireConfigLock(path: string): boolean {
	try {
		writeFileSync(path, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if (!(error instanceof Error) || !isLockContention(error)) throw error;
		return false;
	}
}

function isLockContention(error: Error): boolean {
	return "code" in error && error.code === "EEXIST";
}

function removeStaleConfigLock(path: string): void {
	try {
		if (Date.now() - statSync(path).mtimeMs > 30_000) unlinkSync(path);
	} catch {
		// The lock was removed between inspection and cleanup.
	}
}

function roleConfigKey(role: GovernedRole, setting: RoleSetting): string {
	return `${role}${setting === "model" ? "Model" : "Thinking"}`;
}

function readConfig(path: string): JsonObject | undefined {
	if (!existsSync(path)) return;
	const parsed = parseConfig(readConfigText(path), path);
	if (!isJsonObject(parsed)) throw new ConfigError(`${path} must contain a JSON object.`);
	return parsed;
}

function readConfigText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseConfig(text: string, path: string): JsonValue {
	try {
		// SAFETY: JSON.parse returns a value narrowed by the JsonValue contract before object validation.
		return JSON.parse(text) as JsonValue;
	} catch (error) {
		throw new ConfigError(`${path} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function apply(base: KhalaConfig, values: JsonObject | undefined): KhalaConfig {
	if (values === undefined) {
		return base;
	}
	return {
		archiveRoot: readRequiredPath(values, "archiveRoot", base.archiveRoot),
		worktreeRoot: readRequiredPath(values, "worktreeRoot", base.worktreeRoot),
		worktreeBranchPrefix: readGitBranchPrefix(values, "worktreeBranchPrefix", base.worktreeBranchPrefix),
		targetBranch: readGitBranch(values, "targetBranch", base.targetBranch),
		maxConcurrentExecutions: readPositive(values, "maxConcurrentExecutions", base.maxConcurrentExecutions),
		defaultWorkTokens: readPositive(values, "defaultWorkTokens", base.defaultWorkTokens),
		piCommand: readTextList(values, "piCommand", base.piCommand),
		conclaveModel: readText(values, "conclaveModel", base.conclaveModel),
		conclaveThinking: readText(values, "conclaveThinking", base.conclaveThinking),
		executorModel: readText(values, "executorModel", base.executorModel),
		executorThinking: readText(values, "executorThinking", base.executorThinking),
		oracleModel: readText(values, "oracleModel", base.oracleModel),
		oracleThinking: readText(values, "oracleThinking", base.oracleThinking),
		observerModel: readText(values, "observerModel", base.observerModel),
		observerThinking: readText(values, "observerThinking", base.observerThinking),
		keybindings: {
			roleSettings: readKeybinding(values, "roleSettingsKey", base.keybindings.roleSettings),
			comments: readKeybinding(values, "commentsKey", base.keybindings.comments),
			refresh: readKeybinding(values, "refreshKey", base.keybindings.refresh),
			help: readKeybinding(values, "helpKey", base.keybindings.help),
			history: readKeybinding(values, "historyKey", base.keybindings.history),
		},
	};
}

function readText(values: JsonObject, key: string, fallback: string): string {
	const value = values[key];
	if (value === undefined) {
		return fallback;
	}
	if (value !== String(value)) {
		throw new ConfigError(`${key} must be a string.`);
	}
	return String(value);
}

function readGitBranch(values: JsonObject, key: string, fallback: string): string {
	const value = readNonBlank(values, key, fallback);
	assertGitRef(value, key, false);
	return value;
}

function readGitBranchPrefix(values: JsonObject, key: string, fallback: string): string {
	const value = readNonBlank(values, key, fallback);
	assertGitRef(value, key, true);
	return value;
}

// oxlint-disable-next-line complexity
function assertGitRef(value: string, key: string, allowTrailingSlash: boolean): void {
	if (
		!/^[A-Za-z0-9._/-]+$/.test(value) ||
		value.startsWith("/") ||
		value.startsWith(".") ||
		value.startsWith("-") ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{") ||
		value.endsWith(".") ||
		(!allowTrailingSlash && value.endsWith("/")) ||
		hasInvalidGitRefComponent(value, allowTrailingSlash)
	)
		throw new ConfigError(`${key} must be a valid Git branch name.`);
}

function hasInvalidGitRefComponent(value: string, allowTrailingSlash: boolean): boolean {
	const normalized = allowTrailingSlash && value.endsWith("/") ? value.slice(0, -1) : value;
	return normalized
		.split("/")
		.some((component) => component.startsWith(".") || component.toLowerCase().endsWith(".lock"));
}

function readRequiredPath(values: JsonObject, key: string, fallback: string): string {
	return readNonBlank(values, key, fallback).replace(/^~(?=\/|$)/, homedir());
}

function readNonBlank(values: JsonObject, key: string, fallback: string): string {
	const value = readText(values, key, fallback).trim();
	if (value.length === 0) throw new ConfigError(`${key} must not be blank.`);
	return value;
}

function readKeybinding(values: JsonObject, key: string, fallback: string): string {
	const value = readText(values, key, fallback).trim();
	if (value.length === 0) {
		throw new ConfigError(`${key} must not be blank.`);
	}
	return value;
}

function readPositive(values: JsonObject, key: string, fallback: number): number {
	const value = values[key];
	if (value === undefined) return fallback;
	if (!isPositiveInteger(value)) throw new ConfigError(`${key} must be a positive integer.`);
	return value;
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
	const number = Number(value);
	if (number !== value) return false;
	if (!Number.isSafeInteger(number)) return false;
	return number > 0;
}

function readTextList(values: JsonObject, key: string, fallback: readonly string[]): readonly string[] {
	const value = values[key];
	if (value === undefined) {
		return fallback;
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new ConfigError(`${key} must be a nonempty string list.`);
	}
	return value.map((entry) => {
		const text = readStringValue(entry, key).trim();
		if (text.length === 0) throw new ConfigError(`${key} must contain no blank entries.`);
		return text;
	});
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && Object(value) === value && !Array.isArray(value);
}

function readStringValue(value: JsonValue | undefined, key: string): string {
	if (value === undefined || value !== String(value)) {
		throw new ConfigError(`${key} must be a string.`);
	}
	return String(value);
}
