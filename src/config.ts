import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
	keybindings: Readonly<{ roleSettings: string; comments: string }>;
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
	keybindings: { roleSettings: "r", comments: "c" },
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
	const path = join(agentDirectory(), "khala.json");
	const current = readConfig(path) ?? {};
	const next = { ...current, [roleConfigKey(role, setting)]: normalized };
	mkdirSync(agentDirectory(), { recursive: true });
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
}

function roleConfigKey(role: GovernedRole, setting: RoleSetting): string {
	return `${role}${setting === "model" ? "Model" : "Thinking"}`;
}

function readConfig(path: string): JsonObject | undefined {
	if (!existsSync(path)) {
		return;
	}
	const text = readFileSync(path, "utf8");
	const parsed: JsonValue = JSON.parse(text);
	if (!isJsonObject(parsed)) {
		throw new ConfigError(`${path} must contain a JSON object.`);
	}
	return parsed;
}

function apply(base: KhalaConfig, values: JsonObject | undefined): KhalaConfig {
	if (values === undefined) {
		return base;
	}
	return {
		archiveRoot: readRequiredPath(values, "archiveRoot", base.archiveRoot),
		worktreeRoot: readRequiredPath(values, "worktreeRoot", base.worktreeRoot),
		worktreeBranchPrefix: readNonBlank(values, "worktreeBranchPrefix", base.worktreeBranchPrefix),
		targetBranch: readNonBlank(values, "targetBranch", base.targetBranch),
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
