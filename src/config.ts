import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import type { JsonObject, JsonValue } from "./model.js";

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
	keybindings: Readonly<{ filter: string; help: string }>;
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
	keybindings: { filter: "/", help: "?" },
};

export function loadConfig(projectPath: string, trusted: boolean, requireModels = true): KhalaConfig {
	const globalPath = join(agentDirectory(), "khala.json");
	let config = apply(DEFAULTS, readConfig(globalPath));
	if (trusted) {
		config = apply(config, readConfig(join(projectPath, ".pi", "khala.json")));
	}
	if (requireModels) {
		for (const [field, value] of [
			["conclaveModel", config.conclaveModel],
			["executorModel", config.executorModel],
			["oracleModel", config.oracleModel],
		] as const) {
			if (value.trim().length === 0) {
				throw new ConfigError(`${field} is required. Run \`khala setup\` before starting governed Work.`);
			}
		}
	}
	return config;
}

export function archivePath(config: KhalaConfig, projectPath: string): string {
	const key = createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 24);
	return join(config.archiveRoot, `${key}.sqlite`);
}

export function agentDirectory(): string {
	const configured = process.env["PI_CODING_AGENT_DIR"];
	return configured === undefined || configured.trim().length === 0 ? join(homedir(), ".pi", "agent") : configured;
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
		archiveRoot: readPath(values, "archiveRoot", base.archiveRoot),
		worktreeRoot: readPath(values, "worktreeRoot", base.worktreeRoot),
		worktreeBranchPrefix: readText(values, "worktreeBranchPrefix", base.worktreeBranchPrefix),
		targetBranch: readText(values, "targetBranch", base.targetBranch),
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
			filter: readText(values, "filterKey", base.keybindings.filter),
			help: readText(values, "helpKey", base.keybindings.help),
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

function readPath(values: JsonObject, key: string, fallback: string): string {
	return readText(values, key, fallback).replace(/^~(?=\/|$)/, homedir());
}

function readPositive(values: JsonObject, key: string, fallback: number): number {
	const value = values[key];
	if (value === undefined) {
		return fallback;
	}
	const number = Number(value);
	if (value === null || value === undefined || number !== value || !Number.isSafeInteger(number) || number <= 0) {
		throw new ConfigError(`${key} must be a positive integer.`);
	}
	return number;
}

function readTextList(values: JsonObject, key: string, fallback: readonly string[]): readonly string[] {
	const value = values[key];
	if (value === undefined) {
		return fallback;
	}
	if (!Array.isArray(value)) {
		throw new ConfigError(`${key} must be a nonempty string list.`);
	}
	return value.map((entry) => readStringValue(entry, key));
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

export async function runKhalaSetup(args: readonly string[]): Promise<void> {
	const path = join(agentDirectory(), "khala.json");
	if (args.includes("--dry-run")) {
		process.stdout.write(`${JSON.stringify(DEFAULTS, null, 2)}\n`);
		return;
	}
	const current = readConfig(path) ?? {};
	const updates = parseSetupArguments(args);
	const merged = { ...current, ...updates };
	const required: readonly SetupKey[] = ["conclaveModel", "executorModel", "oracleModel"];
	const missing = required.filter((key) => {
		const value = merged[key];
		return value === undefined || value === "";
	});
	if (missing.length > 0) {
		throw new ConfigError(`Missing ${missing.join(", ")}. Use --conclave-model, --executor-model, and --oracle-model.`);
	}
	mkdirSync(agentDirectory(), { recursive: true });
	writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	loadConfig(process.cwd(), false);
	process.stdout.write(`Khala configuration is ready: ${path}\n`);
}

type SetupValues = Partial<{
	conclaveModel: string;
	executorModel: string;
	oracleModel: string;
	observerModel: string;
	targetBranch: string;
	archiveRoot: string;
	worktreeRoot: string;
	defaultWorkTokens: number;
	maxConcurrentExecutions: number;
}>;
type SetupKey = keyof SetupValues;

function parseSetupArguments(args: readonly string[]): SetupValues {
	const values: SetupValues = {};
	const names = new Map<string, SetupKey>([
		["--conclave-model", "conclaveModel"],
		["--executor-model", "executorModel"],
		["--oracle-model", "oracleModel"],
		["--observer-model", "observerModel"],
		["--target-branch", "targetBranch"],
		["--archive-root", "archiveRoot"],
		["--worktree-root", "worktreeRoot"],
		["--default-work-tokens", "defaultWorkTokens"],
		["--max-concurrent-executions", "maxConcurrentExecutions"],
	]);
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined || argument === "--dry-run") {
			continue;
		}
		const key = names.get(argument);
		if (key === undefined) {
			throw new ConfigError(`Unknown setup argument ${argument}.`);
		}
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new ConfigError(`Setup argument ${argument} requires a value.`);
		}
		index += 1;
		setSetupValue(values, key, value, argument);
	}
	return values;
}

function setSetupValue(values: SetupValues, key: SetupKey, value: string, argument: string): void {
	if (key === "defaultWorkTokens" || key === "maxConcurrentExecutions") {
		const number = Number(value);
		if (!Number.isSafeInteger(number) || number <= 0) {
			throw new ConfigError(`${argument} requires a positive integer.`);
		}
		if (key === "defaultWorkTokens") {
			values.defaultWorkTokens = number;
		} else {
			values.maxConcurrentExecutions = number;
		}
		return;
	}
	values[key] = value;
}
