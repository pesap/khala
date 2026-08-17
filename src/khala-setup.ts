/* biome-ignore-all lint/suspicious/noConsole: This file is the standalone CLI output surface. */
/* biome-ignore-all lint/style/noTernary: Setup projections keep default labels concise. */
/* biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: The setup wizard keeps its interactive transaction together. */
/* biome-ignore-all lint/style/noContinue: The command parser uses early iteration exits. */
/* biome-ignore-all lint/style/noExcessiveLinesPerFile: The standalone wizard is shipped as one CLI module. */

import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process, { stdin as input, stdout as output } from "node:process";
import { autocomplete, text as clackText, confirm, isCancel, select } from "@clack/prompts";
import type { PiCommand } from "./executor.js";
import { StrictJsonlReader } from "./executor-rpc.js";
import { bold, dim, green, row, titleLine, yellow } from "./khala-cli-ui.js";
import {
	ConfigScope,
	type ConfigScopeValue,
	getKhalaConfigPath,
	type KhalaConfig,
	LauncherName,
	loadKhalaConfig,
} from "./khala-config.js";
import { assertPiCommand, isolateOraclePiCommand } from "./khala-pi-command.js";
import { getSupportedThinkingLevels, type ThinkingLevel, type ThinkingModel } from "./khala-thinking.js";

interface SetupOptions {
	scope?: ConfigScopeValue;
	yes: boolean;
	dryRun: boolean;
	help: boolean;
}

type StoredConfig = {
	[K in keyof KhalaConfig]: K extends "piCommand"
		? string[]
		: K extends "conclaveMaxCostUsdPerTurn" | "executorMaxCostUsdPerTurn"
			? number
			: string;
};

const WHITESPACE = /\s/;
const MODEL_LINE_SEPARATOR = /\r?\n/;
const MODEL_COLUMN_SEPARATOR = /\s+/;
const MODEL_HEADER = /^provider\s+model\b/i;
const NO_MODELS_HEADER = /^no models/i;
const PROVIDER_SUMMARY = /^[A-Za-z0-9._:-]+\s+\(/i;
const MIN_MODEL_COLUMNS = 5;
const MODEL_TRAILING_COLUMNS = 3;
const MODEL_TRAILING_COLUMNS_WITH_IMAGES = 4;
const MODEL_DISCOVERY_REQUEST_ID = "khala-model-discovery";
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_DISCOVERY_TERMINATION_GRACE_MS = 250;
const MODEL_LIST_TIMEOUT_MS = 10_000;
const KIBIBYTE = 1024;
const MODEL_LIST_MAX_BUFFER_KIB = 256;
const MODEL_LIST_MAX_BUFFER_BYTES = MODEL_LIST_MAX_BUFFER_KIB * KIBIBYTE;
const MODEL_DISCOVERY_FLAGS = [
	"--mode",
	"rpc",
	"--offline",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
] as const;
const SETUP_CANCELLED_MESSAGE = "Setup cancelled.";
const CANCEL_EXIT_CODE = 130;

type ModelCapability = Readonly<{ thinkingLevels: readonly ThinkingLevel[] }>;
type ModelNameDiscovery = Readonly<{ models: string[]; reason?: string }>;
type ModelDiscovery = Readonly<{
	models: string[];
	capabilities: Readonly<Record<string, ModelCapability>>;
	reason?: string;
}>;
type DiscoveredPiModel = Readonly<ThinkingModel & { id: string; provider: string }>;
type PiModelPayload = Readonly<{
	id?: unknown;
	provider?: unknown;
	reasoning?: unknown;
	thinkingLevelMap?: unknown;
}>;
type ModelsPayload = Readonly<{ models?: unknown }>;
type RpcResponsePayload = Readonly<{
	type?: unknown;
	id?: unknown;
	success?: unknown;
	data?: unknown;
	error?: unknown;
}>;
type ModelDiscoveryResponse =
	| Readonly<{ result: "success"; models: readonly DiscoveredPiModel[] }>
	| Readonly<{ result: "failure"; error: Error }>;

function isInteractive(options: SetupOptions): boolean {
	return !options.yes && input.isTTY === true && output.isTTY === true;
}

function printUsage(): void {
	console.log(`khala - configure Khala

Usage:
  khala [flags]
  khala setup [flags]
  khala --help

The setup wizard writes khala.json for the global Pi installation by default.

Flags:
  -l, --project       Write .pi/khala.json in the current project
      --global        Write ~/.pi/agent/khala.json (default)
  -y, --yes           Use defaults and skip prompts
      --no-input      Alias for --yes
      --dry-run        Show changes without writing files
  -h, --help          Show help
`);
}

// A small explicit parser keeps the public CLI surface predictable for scripts.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each supported flag has distinct validation.
function parseArgs(args: string[]): SetupOptions {
	const options: SetupOptions = { yes: false, dryRun: false, help: false };
	let commandSeen = false;
	for (const arg of args) {
		if (arg === "setup") {
			if (commandSeen) {
				throw new Error(`Unknown argument: ${arg}`);
			}
			commandSeen = true;
			continue;
		}
		if (arg === "--project" || arg === "-l") {
			if (options.scope === ConfigScope.global) {
				throw new Error("Choose either --global or --project, not both.");
			}
			options.scope = ConfigScope.project;
			continue;
		}
		if (arg === "--global") {
			if (options.scope === ConfigScope.project) {
				throw new Error("Choose either --global or --project, not both.");
			}
			options.scope = ConfigScope.global;
			continue;
		}
		if (arg === "--yes" || arg === "-y" || arg === "--no-input") {
			options.yes = true;
			continue;
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

function parseModelListOutput(stdout: string): string[] {
	const models: string[] = [];
	for (const line of stdout.split(MODEL_LINE_SEPARATOR)) {
		const trimmed = line.trim();
		if (
			trimmed.length === 0 ||
			MODEL_HEADER.test(trimmed) ||
			NO_MODELS_HEADER.test(trimmed) ||
			PROVIDER_SUMMARY.test(trimmed)
		) {
			continue;
		}
		const columns = trimmed.split(MODEL_COLUMN_SEPARATOR);
		if (columns.length < MIN_MODEL_COLUMNS) {
			continue;
		}
		const [provider] = columns;
		if (provider === undefined) {
			continue;
		}
		const hasImagesColumn = columns.length > MIN_MODEL_COLUMNS;
		let modelColumns: string[];
		if (hasImagesColumn) {
			modelColumns = columns.slice(1, -MODEL_TRAILING_COLUMNS_WITH_IMAGES);
		} else {
			modelColumns = columns.slice(1, -MODEL_TRAILING_COLUMNS);
		}
		const model = modelColumns.join(" ").trim();
		if (model.length > 0) {
			models.push(`${provider}/${model}`);
		}
	}
	return [...new Set(models)];
}

function discoverConfiguredModelNames(
	command: PiCommand,
	options: Readonly<{ timeoutMs?: number; maxBufferBytes?: number }> = {},
): ModelNameDiscovery {
	const [program, ...arguments_] = command;
	let result: SpawnSyncReturns<string>;
	try {
		result = spawnSync(program, [...arguments_, "--list-models"], {
			encoding: "utf8",
			timeout: options.timeoutMs ?? MODEL_LIST_TIMEOUT_MS,
			maxBuffer: options.maxBufferBytes ?? MODEL_LIST_MAX_BUFFER_BYTES,
		});
	} catch {
		// spawnSync throws when stdout or stderr exceeds maxBuffer; never parse partial output.
		return { models: [], reason: "Pi model discovery output exceeded the size limit" };
	}
	if (result.error !== undefined) {
		const errorCode = (result.error as NodeJS.ErrnoException).code;
		if (errorCode === "ETIMEDOUT") {
			return { models: [], reason: "Pi model discovery timed out" };
		}
		if (errorCode === "ENOBUFS" || errorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			return { models: [], reason: "Pi model discovery output exceeded the size limit" };
		}
		return { models: [], reason: result.error.message };
	}
	if (result.status !== 0) {
		return { models: [], reason: `Pi exited with status ${result.status ?? 1}` };
	}
	const models = parseModelListOutput(result.stdout ?? "");
	if (models.length === 0) {
		return { models, reason: "Pi returned no configured models" };
	}
	return { models };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevelMap(value: unknown): value is Partial<Record<ThinkingLevel, string | null>> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string" || entry === null);
}

function readDiscoveredPiModel(value: unknown): DiscoveredPiModel | undefined {
	if (!isRecord(value)) {
		return;
	}
	const candidate = value as PiModelPayload;
	if (typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
		return;
	}
	const { thinkingLevelMap } = candidate;
	if (thinkingLevelMap !== undefined && !isThinkingLevelMap(thinkingLevelMap)) {
		return;
	}
	let model: DiscoveredPiModel = { id: candidate.id, provider: candidate.provider };
	if (typeof candidate.reasoning === "boolean") {
		model = { ...model, reasoning: candidate.reasoning };
	}
	if (thinkingLevelMap !== undefined) {
		model = { ...model, thinkingLevelMap };
	}
	return model;
}

function readConfiguredModels(value: unknown): readonly DiscoveredPiModel[] {
	if (!isRecord(value)) {
		throw new Error("Pi RPC model discovery returned invalid data.");
	}
	const { models: candidates } = value as ModelsPayload;
	if (!Array.isArray(candidates)) {
		throw new Error("Pi RPC model discovery returned invalid data.");
	}
	const models: DiscoveredPiModel[] = [];
	for (const candidate of candidates) {
		const model = readDiscoveredPiModel(candidate);
		if (model === undefined) {
			throw new Error("Pi RPC model discovery returned an invalid model.");
		}
		models.push(model);
	}
	return models;
}

function normalizeModelDiscoveryError(error: unknown, prefix: string): Error {
	return error instanceof Error ? error : new Error(`${prefix}: ${String(error)}`);
}

function readModelDiscoveryResponse(value: unknown): ModelDiscoveryResponse | undefined {
	if (!isRecord(value)) {
		return;
	}
	const response = value as RpcResponsePayload;
	if (response.type !== "response" || response.id !== MODEL_DISCOVERY_REQUEST_ID) {
		return;
	}
	if (response.success !== true) {
		const message = typeof response.error === "string" ? response.error : "Pi model discovery failed.";
		return { result: "failure", error: new Error(message) };
	}
	try {
		return { result: "success", models: readConfiguredModels(response.data) };
	} catch (error) {
		// A matching RPC response with invalid data is a protocol failure, not a
		// partial capability result.
		return {
			result: "failure",
			error: normalizeModelDiscoveryError(error, "Pi model discovery returned invalid data"),
		};
	}
}

function discoverModelsThroughPiRpc(command: PiCommand): Promise<readonly DiscoveredPiModel[]> {
	const [program, ...arguments_] = isolateOraclePiCommand(command);
	return new Promise((resolve, reject) => {
		const child = spawn(program, [...arguments_, ...MODEL_DISCOVERY_FLAGS], { stdio: ["pipe", "pipe", "pipe"] });
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let terminationTimeout: ReturnType<typeof setTimeout> | undefined;
		const clearTerminationTimeout = (): void => {
			if (terminationTimeout !== undefined) {
				clearTimeout(terminationTimeout);
				terminationTimeout = undefined;
			}
		};
		const closeChild = (): void => {
			try {
				child.stdin?.end();
			} catch {
				// The child may already have closed its input stream.
			}
			// A wrapper can leave a descendant holding an inherited pipe after the
			// direct child exits. Release our pipe ends once discovery settles so it
			// cannot keep standalone setup alive.
			child.stdin?.destroy();
			child.stdout?.destroy();
			child.stderr?.destroy();
			child.unref();
			if (child.exitCode !== null || child.signalCode !== null) {
				return;
			}
			try {
				child.kill("SIGTERM");
			} catch {
				// A concurrent exit owns child cleanup.
				return;
			}
			// Keep this timer referenced: otherwise standalone setup could exit before
			// escalation runs and leave a signal-ignoring Pi wrapper behind.
			terminationTimeout = setTimeout(() => {
				terminationTimeout = undefined;
				if (child.exitCode !== null || child.signalCode !== null) {
					return;
				}
				try {
					child.kill("SIGKILL");
				} catch {
					// A concurrent exit already owns termination.
				}
			}, MODEL_DISCOVERY_TERMINATION_GRACE_MS);
		};
		const fail = (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			closeChild();
			reject(error);
		};
		const succeed = (models: readonly DiscoveredPiModel[]): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeout !== undefined) {
				clearTimeout(timeout);
			}
			closeChild();
			resolve(models);
		};
		const reader = new StrictJsonlReader((record) => {
			const response = readModelDiscoveryResponse(record);
			if (response === undefined) {
				return;
			}
			if (response.result === "failure") {
				fail(response.error);
				return;
			}
			succeed(response.models);
		});
		child.stdout?.on("data", (chunk: Buffer | string) => {
			try {
				reader.push(chunk);
			} catch (error) {
				fail(normalizeModelDiscoveryError(error, "Pi model discovery returned invalid JSON"));
			}
		});
		child.stdout?.on("end", () => {
			try {
				reader.end();
			} catch (error) {
				fail(normalizeModelDiscoveryError(error, "Pi model discovery returned invalid JSON"));
			}
		});
		child.stdout?.on("error", (error) => fail(error));
		child.stderr?.on("error", (error) => fail(error));
		// Drain diagnostics so a failing child cannot block on pipe backpressure. Do
		// not surface arbitrary child stderr through the interactive setup UI.
		child.stderr?.resume();
		child.once("error", (error) => fail(error));
		// A wrapper can exit while a descendant still flushes the inherited stdout
		// pipe. `close` waits for that pipe to drain, unlike `exit`.
		child.once("close", (code, signal) => {
			clearTerminationTimeout();
			fail(new Error(`Pi model discovery closed before responding (${code ?? "null"}, ${signal ?? "none"}).`));
		});
		child.stdin?.on("error", (error) => fail(error));
		timeout = setTimeout(
			() => fail(new Error(`Pi model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`)),
			MODEL_DISCOVERY_TIMEOUT_MS,
		);
		const { stdin } = child;
		if (stdin === null || stdin.destroyed) {
			fail(new Error("Pi model discovery could not open its input stream."));
			return;
		}
		try {
			stdin.write(`${JSON.stringify({ id: MODEL_DISCOVERY_REQUEST_ID, type: "get_available_models" })}\n`, (error) => {
				if (error !== undefined && error !== null) {
					fail(error);
				}
			});
		} catch (error) {
			fail(normalizeModelDiscoveryError(error, "Pi model discovery request failed"));
		}
	});
}

async function discoverConfiguredModels(command: PiCommand): Promise<ModelDiscovery> {
	const listed = discoverConfiguredModelNames(command);
	if (listed.reason !== undefined) {
		return { models: listed.models, capabilities: {}, reason: listed.reason };
	}
	try {
		const discoveredModels = await discoverModelsThroughPiRpc(command);
		const capabilities: Record<string, ModelCapability> = {};
		for (const model of discoveredModels) {
			const modelId = `${model.provider}/${model.id}`;
			capabilities[modelId] = { thinkingLevels: getSupportedThinkingLevels(model) };
		}
		return { models: listed.models, capabilities };
	} catch (error) {
		// This UI discovery boundary keeps the RPC diagnostic visible to interactive
		// setup. Non-interactive setup receives `reason` and rejects any explicit
		// thinking level that cannot be validated before configuration is written.
		const reason = error instanceof Error ? error.message : String(error);
		return {
			models: listed.models,
			capabilities: {},
			reason: `Pi thinking capability discovery unavailable: ${reason}`,
		};
	}
}

function modelChoices(models: readonly string[]): string[] {
	return [...new Set(models)];
}

async function searchModel(label: string, models: readonly string[], defaultModel: string): Promise<string> {
	const choices = modelChoices(models);
	if (choices.length === 0) {
		return defaultModel;
	}
	let selectedDefault = defaultModel;
	if (!choices.includes(selectedDefault)) {
		selectedDefault = "";
	}
	const result = await autocomplete({
		message: label,
		options: choices.map((model) => ({ value: model, label: model })),
		initialValue: selectedDefault,
		placeholder: "Type to filter configured models...",
		maxItems: 10,
	});
	if (isCancel(result)) {
		throw new Error(SETUP_CANCELLED_MESSAGE);
	}
	return result;
}

function readStoredValues(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) {
		return {};
	}
	const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Khala config must be an object: ${configPath}`);
	}
	return parsed as Record<string, unknown>;
}

function commandText(command: readonly string[]): string {
	const formatted: string[] = [];
	for (const part of command) {
		if (WHITESPACE.test(part)) {
			formatted.push(JSON.stringify(part));
		} else {
			formatted.push(part);
		}
	}
	return formatted.join(" ");
}

// Parse the same small command syntax shown by the wizard without invoking a shell.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The state machine keeps command parsing shell-free.
function parseCommand(value: string, label: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const character of value.trim()) {
		if (escaping) {
			current += character;
			escaping = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
			} else {
				current += character;
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
		} else if (WHITESPACE.test(character)) {
			if (current.length > 0) {
				parts.push(current);
				current = "";
			}
		} else {
			current += character;
		}
	}
	if (escaping || quote !== undefined) {
		throw new Error(`${label} contains an unfinished quote or escape.`);
	}
	if (current.length > 0) {
		parts.push(current);
	}
	if (parts.length === 0) {
		throw new Error(`${label} cannot be empty.`);
	}
	return parts;
}

function toStoredConfig(config: KhalaConfig): StoredConfig {
	return {
		worktreeRoot: config.worktreeRoot,
		worktreeBranchPrefix: config.worktreeBranchPrefix,
		launcher: config.launcher,
		piCommand: [...config.piCommand],
		conclaveModel: config.conclaveModel,
		conclaveMaxCostUsdPerTurn: config.conclaveMaxCostUsdPerTurn,
		executorModel: config.executorModel,
		executorMaxCostUsdPerTurn: config.executorMaxCostUsdPerTurn,
		oracleModel: config.oracleModel,
		observerModel: config.observerModel,
		conclaveThinking: config.conclaveThinking,
		executorThinking: config.executorThinking,
		oracleThinking: config.oracleThinking,
		observerThinking: config.observerThinking,
		pullRequestTargetBranch: config.pullRequestTargetBranch,
		commitConvention: config.commitConvention,
		archiveRoot: config.archiveRoot,
	};
}

function configValuesEqual(left: StoredConfig[keyof StoredConfig], right: StoredConfig[keyof StoredConfig]): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}
	return left === right;
}

function createProjectConfigOverrides(base: StoredConfig, config: StoredConfig): Partial<StoredConfig> {
	const overrides: Partial<StoredConfig> = {};
	for (const key of Object.keys(config) as (keyof StoredConfig)[]) {
		if (!configValuesEqual(base[key], config[key])) {
			Object.assign(overrides, { [key]: config[key] });
		}
	}
	return overrides;
}

function writeConfig(request: {
	configPath: string;
	existing: Record<string, unknown>;
	completeConfig: StoredConfig;
	persistedConfig: StoredConfig | Partial<StoredConfig>;
	retainUnknown: boolean;
}): void {
	const { configPath, existing, completeConfig, persistedConfig, retainUnknown } = request;
	let retained: Record<string, unknown> = {};
	if (retainUnknown) {
		retained = Object.fromEntries(
			Object.entries(existing).filter(([key]) => !(key in completeConfig) && key !== "observerPiCommand"),
		);
	}
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify({ ...retained, ...persistedConfig }, null, 2)}\n`, "utf8");
}

function unwrapPrompt<T>(result: T | symbol): T {
	if (isCancel(result)) {
		throw new Error(SETUP_CANCELLED_MESSAGE);
	}
	return result;
}

async function askLine(label: string, defaultValue: string, initialValue = defaultValue): Promise<string> {
	const result = await clackText({
		message: label,
		initialValue,
		defaultValue,
	});
	return unwrapPrompt(result).trim() || defaultValue;
}

async function askOptionalLine(label: string, currentValue: string): Promise<string> {
	const result = await clackText({
		message: label,
		initialValue: currentValue,
		defaultValue: "",
	});
	return unwrapPrompt(result).trim();
}

async function askCost(label: string, currentValue: number): Promise<number> {
	const result = await clackText({
		message: label,
		initialValue: formatCost(currentValue),
		defaultValue: formatCost(currentValue),
		validate: (value) => {
			const parsed = Number(value);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return "Enter a finite number greater than zero.";
			}
			// biome-ignore lint/complexity/noUselessUndefined: Clack's validator requires an explicit valid result.
			return undefined;
		},
	});
	return Number(unwrapPrompt(result));
}

function formatCost(value: number): string {
	return Number.isFinite(value) && value > 0 ? String(value) : "";
}

function normalizeBranchPrefix(prefix: string): string {
	if (prefix.endsWith("/")) {
		return prefix;
	}
	return `${prefix}/`;
}

async function askChoice(label: string, choices: readonly string[], defaultValue: string): Promise<string> {
	const result = await select({
		message: label,
		options: choices.map((choice) => ({ value: choice, label: choice })),
		initialValue: defaultValue,
		maxItems: 10,
	});
	return unwrapPrompt(result);
}

const THINKING_DEFAULT_LABEL = "Pi default";

function thinkingLabel(level: string): string {
	return level.length > 0 ? level : THINKING_DEFAULT_LABEL;
}

function thinkingValue(label: string): string {
	return label === THINKING_DEFAULT_LABEL ? "" : label;
}

function thinkingChoices(capabilities: Readonly<Record<string, ModelCapability>>, model: string): readonly string[] {
	const levels = capabilities[model]?.thinkingLevels ?? [];
	if (levels.length === 0) {
		return [];
	}
	return [THINKING_DEFAULT_LABEL, ...levels];
}

async function askThinking(
	label: string,
	current: string,
	capabilities: Readonly<Record<string, ModelCapability>>,
	model: string,
): Promise<string> {
	const choices = thinkingChoices(capabilities, model);
	if (choices.length === 0) {
		return current;
	}
	const defaultValue = choices.includes(current) ? current : THINKING_DEFAULT_LABEL;
	const selected = await askChoice(label, choices, thinkingLabel(defaultValue));
	return thinkingValue(selected);
}

async function askConfirmation(): Promise<boolean> {
	return unwrapPrompt(
		await confirm({
			message: "Write this configuration?",
			initialValue: true,
		}),
	);
}

function printState(scope: ConfigScopeValue, configPath: string, config: StoredConfig, exists: boolean): void {
	console.log("");
	console.log(titleLine("Khala configuration"));
	let marker = "+";
	if (exists) {
		marker = "=";
	}
	console.log(row(marker, "scope", scope));
	console.log(row(marker, "target", configPath));
	console.log(row("=", "launcher", config.launcher));
	console.log(row("=", "worktree root", config.worktreeRoot));
	console.log(row("=", "branch prefix", config.worktreeBranchPrefix));
	console.log(row("=", "Pi command", commandText(config.piCommand)));
	console.log(row("=", "Conclave model", config.conclaveModel || "(required)"));
	console.log(row("=", "Conclave thinking", config.conclaveThinking || "(Pi default)"));
	console.log(row("=", "Conclave max cost", formatCost(config.conclaveMaxCostUsdPerTurn)));
	console.log(row("=", "Executor model", config.executorModel || "(required)"));
	console.log(row("=", "Executor thinking", config.executorThinking || "(Pi default)"));
	console.log(row("=", "Executor max cost", formatCost(config.executorMaxCostUsdPerTurn)));
	console.log(row("=", "Oracle model", config.oracleModel || "(required)"));
	console.log(row("=", "Oracle thinking", config.oracleThinking || "(Pi default)"));
	console.log(row("=", "Observer model", config.observerModel || "(Pi default)"));
	console.log(row("=", "Observer thinking", config.observerThinking || "(Pi default)"));
	console.log(row("=", "PR publication", "mandatory"));
	console.log(row("=", "PR target branch", config.pullRequestTargetBranch || "(repository default)"));
	console.log(row("=", "commit convention", config.commitConvention));
	console.log(row("=", "archive root", config.archiveRoot));
}

async function chooseScope(options: SetupOptions): Promise<ConfigScopeValue> {
	if (options.scope !== undefined || !isInteractive(options)) {
		return options.scope ?? ConfigScope.global;
	}
	const choice = await askChoice(
		"Install scope",
		["global  — ~/.pi/agent/khala.json", "project — .pi/khala.json"],
		"global  — ~/.pi/agent/khala.json",
	);
	if (choice.startsWith("project")) {
		return ConfigScope.project;
	}
	return ConfigScope.global;
}

async function editConfig(current: StoredConfig): Promise<StoredConfig> {
	console.log(`\n${bold("Runtime")} ${dim("Press Enter to accept the default.")}`);
	const launcher = await askChoice(
		"Launcher",
		[LauncherName.zellij, LauncherName.tmux, LauncherName.herdr],
		current.launcher,
	);
	const worktreeRoot = await askLine("Worktree root (leave blank for ~/worktrees)", current.worktreeRoot, "");
	const worktreeBranchPrefix = normalizeBranchPrefix(
		await askLine(
			`Worktree branch prefix (leave blank for \`${current.worktreeBranchPrefix}\`)`,
			current.worktreeBranchPrefix,
			"",
		),
	);
	const selectedPiCommand = assertPiCommand(
		parseCommand(await askLine("Pi command", commandText(current.piCommand)), "Pi command"),
	);
	const piCommand = [...selectedPiCommand];
	const discovery = await discoverConfiguredModels(selectedPiCommand);
	if (discovery.reason !== undefined) {
		console.log(`\n${yellow(`Model discovery unavailable: ${discovery.reason}`)}`);
	}
	const { models, capabilities } = discovery;
	let {
		conclaveModel,
		executorModel,
		oracleModel,
		observerModel,
		conclaveThinking,
		executorThinking,
		oracleThinking,
		observerThinking,
	} = current;

	console.log(`\n${bold("Conclave")}`);
	if (models.length > 0) {
		conclaveModel = await searchModel("Model", models, conclaveModel);
	}
	conclaveThinking = await askThinking("Thinking level", conclaveThinking, capabilities, conclaveModel);
	const conclaveMaxCostUsdPerTurn = await askCost("Max cost per turn (USD)", current.conclaveMaxCostUsdPerTurn);

	console.log(`\n${bold("Executor")}`);
	if (models.length > 0) {
		executorModel = await searchModel("Model", models, executorModel);
	}
	executorThinking = await askThinking("Thinking level", executorThinking, capabilities, executorModel);
	const executorMaxCostUsdPerTurn = await askCost("Max cost per turn (USD)", current.executorMaxCostUsdPerTurn);

	console.log(`\n${bold("Oracle")}`);
	if (models.length > 0) {
		oracleModel = await searchModel("Model", models, oracleModel || conclaveModel);
	}
	oracleThinking = await askThinking("Thinking level", oracleThinking, capabilities, oracleModel);

	console.log(`\n${bold("Observer")}`);
	if (models.length > 0) {
		observerModel = await searchModel("Model", models, observerModel || conclaveModel);
	}
	observerThinking = await askThinking("Thinking level", observerThinking, capabilities, observerModel);

	console.log(`\n${bold("Review and Archive")}`);
	const pullRequestTargetBranch = await askOptionalLine(
		"PR target branch (leave blank for repository default)",
		current.pullRequestTargetBranch,
	);
	const commitConvention = await askLine(
		"Commit convention (project, conventional, or custom prefix)",
		current.commitConvention,
	);
	const archiveRoot = await askLine("Archive root", current.archiveRoot);
	return {
		launcher,
		worktreeRoot,
		worktreeBranchPrefix,
		piCommand,
		conclaveModel,
		conclaveMaxCostUsdPerTurn,
		executorModel,
		executorMaxCostUsdPerTurn,
		oracleModel,
		observerModel,
		conclaveThinking,
		executorThinking,
		oracleThinking,
		observerThinking,
		pullRequestTargetBranch,
		commitConvention,
		archiveRoot,
	};
}

function validateSetupConfig(config: StoredConfig, interactive: boolean): void {
	if (config.conclaveModel.trim().length === 0 || config.executorModel.trim().length === 0) {
		throw new Error(
			`${interactive ? "Setup" : "Non-interactive setup"} requires non-empty conclaveModel and executorModel; rerun setup and select both models.`,
		);
	}
	if (
		!Number.isFinite(config.conclaveMaxCostUsdPerTurn) ||
		config.conclaveMaxCostUsdPerTurn <= 0 ||
		!Number.isFinite(config.executorMaxCostUsdPerTurn) ||
		config.executorMaxCostUsdPerTurn <= 0
	) {
		throw new Error(
			`${interactive ? "Setup" : "Non-interactive setup"} requires positive finite Conclave and Executor cost thresholds; rerun setup and configure both values.`,
		);
	}
	if (config.oracleModel.trim().length === 0) {
		if (interactive) {
			throw new Error("Setup requires a non-empty oracleModel; choose Reconfigure everything and select a model.");
		}
		throw new Error("Non-interactive setup requires a non-empty oracleModel; configure a model or run interactively.");
	}
	if (config.worktreeRoot.trim().length === 0 || config.worktreeBranchPrefix.trim().length === 0) {
		throw new Error("Setup requires a non-empty worktree root and branch prefix.");
	}
	assertPiCommand(config.piCommand);
}

type NonInteractiveThinkingValidation = Readonly<{
	configuredModel: string;
	configuredThinking: string;
	thinkingField: string;
	capabilities: Readonly<Record<string, ModelCapability>>;
	discoveryReason: string | undefined;
}>;

function validateNonInteractiveThinking(request: NonInteractiveThinkingValidation): void {
	const { configuredModel, configuredThinking, thinkingField, capabilities, discoveryReason } = request;
	if (configuredThinking.length === 0) {
		return;
	}
	if (discoveryReason !== undefined) {
		throw new Error(
			`Non-interactive setup cannot validate configured ${thinkingField} '${configuredThinking}' for ${configuredModel}: ${discoveryReason}`,
		);
	}
	const capability = capabilities[configuredModel];
	if (capability === undefined) {
		throw new Error(
			`Non-interactive setup cannot validate configured ${thinkingField} '${configuredThinking}' for ${configuredModel}: Pi returned no capability metadata for that model.`,
		);
	}
	if (!capability.thinkingLevels.includes(configuredThinking as ThinkingLevel)) {
		throw new Error(
			`Configured ${thinkingField} '${configuredThinking}' is not supported by ${configuredModel}. Rerun setup and select a supported level.`,
		);
	}
}

function chooseNonInteractiveModels(
	config: StoredConfig,
	models: readonly string[],
	capabilities: Readonly<Record<string, ModelCapability>> = {},
	discoveryReason?: string,
): StoredConfig {
	for (const [modelField, thinkingField] of [
		["conclaveModel", "conclaveThinking"],
		["executorModel", "executorThinking"],
		["oracleModel", "oracleThinking"],
		["observerModel", "observerThinking"],
	] as const) {
		const configuredModel = config[modelField];
		if (configuredModel.trim().length === 0) {
			if (modelField === "observerModel") {
				continue;
			}
			throw new Error(`Non-interactive setup requires an explicit ${modelField}; no model fallback is available.`);
		}
		if (models.length > 0 && !models.includes(configuredModel)) {
			throw new Error(
				`Configured ${modelField} '${configuredModel}' was not discovered by Pi. Rerun setup after configuring that model or select another model.`,
			);
		}
		validateNonInteractiveThinking({
			configuredModel,
			configuredThinking: config[thinkingField] ?? "",
			thinkingField,
			capabilities,
			discoveryReason,
		});
	}
	return config;
}

async function configure(options: SetupOptions): Promise<void> {
	const scope = await chooseScope(options);
	let projectPath: string | undefined;
	if (scope === ConfigScope.project) {
		projectPath = process.cwd();
	}
	const configPath = getKhalaConfigPath(scope, projectPath);
	const existing = readStoredValues(configPath);
	const globalConfig = toStoredConfig(loadKhalaConfig(undefined, false, false));
	const currentConfig = toStoredConfig(loadKhalaConfig(projectPath, scope === ConfigScope.project, false));
	const interactive = isInteractive(options);
	console.log(`\n${titleLine("Khala setup")}`);
	console.log(dim("Configure the durable state, worktree, launcher, and model settings used by Khala."));
	if (Object.keys(existing).length > 0 && interactive) {
		const choice = await askChoice(
			"Existing configuration",
			["Keep current configuration", "Reconfigure everything"],
			"Keep current configuration",
		);
		if (choice === "Keep current configuration") {
			validateSetupConfig(currentConfig, true);
			console.log(`\n${green("Done.")} ${dim("Nothing changed.")}`);
			return;
		}
	}
	let next = currentConfig;
	if (interactive) {
		next = await editConfig(currentConfig);
	} else {
		const discovery = await discoverConfiguredModels(assertPiCommand(currentConfig.piCommand));
		next = chooseNonInteractiveModels(currentConfig, discovery.models, discovery.capabilities, discovery.reason);
	}
	validateSetupConfig(next, interactive);
	printState(scope, configPath, next, Object.keys(existing).length > 0);
	if (options.dryRun) {
		console.log(`\n${yellow("Dry run.")} ${dim(`Run without --dry-run to write ${configPath}.`)}`);
		return;
	}
	if (interactive && !(await askConfirmation())) {
		console.log(`\n${dim("Skipped.")} ${dim("No files were written.")}`);
		return;
	}
	const persistedConfig = scope === ConfigScope.project ? createProjectConfigOverrides(globalConfig, next) : next;
	writeConfig({
		configPath,
		existing,
		completeConfig: next,
		persistedConfig,
		retainUnknown: scope === ConfigScope.global,
	});
	console.log(`\n${green(bold("Done."))} ${dim(`Wrote ${configPath}`)}`);
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	try {
		const options = parseArgs(args);
		if (options.help) {
			printUsage();
			return;
		}
		await configure(options);
	} catch (error) {
		if (error instanceof Error && error.message === SETUP_CANCELLED_MESSAGE) {
			process.exitCode = CANCEL_EXIT_CODE;
			return;
		}
		let message: string;
		if (error instanceof Error) {
			const { message: errorMessage } = error;
			message = errorMessage;
		} else {
			message = String(error);
		}
		console.error(`khala: ${message}`);
		process.exitCode = 2;
	}
}

if (process.argv[1]?.endsWith("khala-setup.js") || process.argv[1]?.endsWith("khala-setup.ts")) {
	await main();
}

export {
	chooseNonInteractiveModels,
	createProjectConfigOverrides,
	discoverConfiguredModelNames,
	main as runKhalaSetup,
	parseCommand,
	thinkingChoices,
};
