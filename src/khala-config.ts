// biome-ignore-all lint/style/noExcessiveLinesPerFile: Configuration parsing keeps inheritance and diagnostics in one module.
// biome-ignore-all lint/style/noExcessiveClassesPerFile: The base and supervision-specific diagnostics form one configuration error hierarchy.
// biome-ignore-all lint/security/noSecrets: Config field names resemble credential identifiers but contain no secrets.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiCommand } from "./executor.js";
import type { KhalaWork } from "./khala-model.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const LauncherName = {
	zellij: "zellij",
	tmux: "tmux",
	herdr: "herdr",
} as const;
type LauncherNameValue = (typeof LauncherName)[keyof typeof LauncherName];

const ConfigScope = {
	global: "global",
	project: "project",
} as const;
type ConfigScopeValue = (typeof ConfigScope)[keyof typeof ConfigScope];

type EffectiveWorkBudget = Readonly<{
	conclaveMaxCostUsdPerTurn: number;
	executorMaxCostUsdPerTurn: number;
}>;

interface KhalaConfig {
	worktreeRoot: string;
	worktreeBranchPrefix: string;
	launcher: LauncherNameValue;
	piCommand: PiCommand;
	observerPiCommand: PiCommand;
	conclaveModel: string;
	conclaveMaxCostUsdPerTurn: number;
	executorModel: string;
	executorMaxCostUsdPerTurn: number;
	oracleModel: string;
	observerModel: string;
	conclaveThinking: ThinkingLevel | "";
	executorThinking: ThinkingLevel | "";
	observerThinking: ThinkingLevel | "";
	pullRequestTargetBranch: string;
	commitConvention: string;
	archiveRoot: string;
}

type ConfigValues = Record<string, unknown>;
type ErrorCauseOptions = Readonly<{ cause?: unknown }>;

class KhalaConfigError extends Error {
	readonly cause: unknown;

	constructor(message: string, options?: ErrorCauseOptions) {
		super(message);
		this.name = "KhalaConfigError";
		this.cause = options?.cause;
	}
}

class KhalaSupervisionConfigError extends KhalaConfigError {
	readonly missingFields: readonly string[];

	constructor(missingFields: readonly string[]) {
		super(
			`Khala supervision configuration is incomplete or invalid (${missingFields.join(", ")}). ` +
				`Run \`${KHALA_SETUP_COMMAND}\` to configure Khala.`,
		);
		this.name = "KhalaSupervisionConfigError";
		this.missingFields = [...missingFields];
	}
}

// The config shape follows the package's GitHub release version; it does not carry a separate persisted version.
const CONFIG_FILE_NAME = "khala.json";
const KHALA_SETUP_COMMAND = "npx --yes github:pesap/khala";
const PI_COMMAND_SUFFIX_PATTERN = /\.(cmd|exe)$/i;
const DEFAULT_CONFIG: Omit<KhalaConfig, "archiveRoot"> = {
	worktreeRoot: join(homedir(), "worktrees"),
	worktreeBranchPrefix: "khala/",
	launcher: LauncherName.zellij,
	piCommand: ["pi"],
	observerPiCommand: ["pi"],
	conclaveModel: "",
	conclaveMaxCostUsdPerTurn: 0,
	executorModel: "",
	executorMaxCostUsdPerTurn: 0,
	oracleModel: "",
	observerModel: "",
	conclaveThinking: "",
	executorThinking: "",
	observerThinking: "",
	pullRequestTargetBranch: "",
	commitConvention: "project",
};

function getDefaultConfig(): KhalaConfig {
	return { ...DEFAULT_CONFIG, archiveRoot: join(getAgentDir(), "khala", "conclaves") };
}

function loadKhalaConfig(projectPath?: string, projectTrusted = false, requireSupervision = true): KhalaConfig {
	try {
		let config = applyConfig(getDefaultConfig(), readConfigFile(getKhalaConfigPath(ConfigScope.global)));
		if (projectPath !== undefined && projectTrusted) {
			config = applyConfig(config, readConfigFile(getKhalaConfigPath(ConfigScope.project, projectPath)));
		}
		if (requireSupervision) {
			validateRequiredSupervisionConfig(config);
		}
		return config;
	} catch (error) {
		if (error instanceof KhalaConfigError) {
			throw error;
		}
		let message = String(error);
		if (error instanceof Error) {
			({ message } = error);
		}
		throw new KhalaConfigError(`${message} Run \`${KHALA_SETUP_COMMAND}\` to repair Khala configuration.`, {
			cause: error,
		});
	}
}

function getKhalaConfigPath(scope: ConfigScopeValue, projectPath?: string): string {
	if (scope === ConfigScope.global) {
		return join(getAgentDir(), CONFIG_FILE_NAME);
	}
	if (projectPath === undefined) {
		throw new Error("A project path is required for project Khala configuration.");
	}
	return join(projectPath, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Configuration merging is intentionally centralized to preserve inheritance semantics.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Configuration precedence is intentionally explicit for each persisted setting.
function applyConfig(base: KhalaConfig, values: ConfigValues | undefined): KhalaConfig {
	if (values === undefined) {
		return base;
	}

	const configuredWorktreeRoot = readRequiredConfigString(values, "worktreeRoot");
	const configuredBranchPrefix = readRequiredConfigString(values, "worktreeBranchPrefix");
	const configuredLauncher = readLauncher(values, "launcher");
	const configuredPiCommand = readPiCommand(values, "piCommand");
	const configuredObserverPiCommand = readObserverPiCommand(values, "observerPiCommand");
	const configuredConclaveModel = readRequiredConfigString(values, "conclaveModel");
	const configuredConclaveMaxCostUsdPerTurn = readPositiveFiniteNumber(values, "conclaveMaxCostUsdPerTurn");
	const configuredExecutorModel = readRequiredConfigString(values, "executorModel");
	const configuredExecutorMaxCostUsdPerTurn = readPositiveFiniteNumber(values, "executorMaxCostUsdPerTurn");
	const configuredOracleModel = readConfigString(values, "oracleModel");
	const configuredObserverModel = readConfigString(values, "observerModel");
	const configuredConclaveThinking = readThinkingLevel(values, "conclaveThinking");
	const configuredExecutorThinking = readThinkingLevel(values, "executorThinking");
	const configuredObserverThinking = readThinkingLevel(values, "observerThinking");
	const configuredPullRequestTargetBranch = readConfigText(values, "pullRequestTargetBranch");
	const configuredCommitConvention = readRequiredConfigString(values, "commitConvention");
	const configuredArchiveRoot = readRequiredConfigString(values, "archiveRoot");
	const {
		worktreeRoot: defaultWorktreeRoot,
		worktreeBranchPrefix: defaultBranchPrefix,
		launcher: defaultLauncher,
		piCommand: defaultPiCommand,
		observerPiCommand: defaultObserverPiCommand,
		conclaveModel: defaultConclaveModel,
		conclaveMaxCostUsdPerTurn: defaultConclaveMaxCostUsdPerTurn,
		executorModel: defaultExecutorModel,
		executorMaxCostUsdPerTurn: defaultExecutorMaxCostUsdPerTurn,
		oracleModel: defaultOracleModel,
		observerModel: defaultObserverModel,
		conclaveThinking: defaultConclaveThinking,
		executorThinking: defaultExecutorThinking,
		observerThinking: defaultObserverThinking,
		pullRequestTargetBranch: defaultPullRequestTargetBranch,
		commitConvention: defaultCommitConvention,
		archiveRoot: defaultArchiveRoot,
	} = base;
	let worktreeRoot = defaultWorktreeRoot;
	let worktreeBranchPrefix = defaultBranchPrefix;
	let launcher = defaultLauncher;
	let piCommand = defaultPiCommand;
	let observerPiCommand = defaultObserverPiCommand;
	let conclaveModel = defaultConclaveModel;
	let conclaveMaxCostUsdPerTurn = defaultConclaveMaxCostUsdPerTurn;
	let executorModel = defaultExecutorModel;
	let executorMaxCostUsdPerTurn = defaultExecutorMaxCostUsdPerTurn;
	let oracleModel = defaultOracleModel;
	let observerModel = defaultObserverModel;
	let conclaveThinking = defaultConclaveThinking;
	let executorThinking = defaultExecutorThinking;
	let observerThinking = defaultObserverThinking;
	let pullRequestTargetBranch = defaultPullRequestTargetBranch;
	let commitConvention = defaultCommitConvention;
	let archiveRoot = defaultArchiveRoot;
	if (configuredWorktreeRoot !== undefined) {
		worktreeRoot = expandHome(configuredWorktreeRoot);
	}
	if (configuredBranchPrefix !== undefined) {
		worktreeBranchPrefix = configuredBranchPrefix;
	}
	if (configuredLauncher !== undefined) {
		launcher = configuredLauncher;
	}
	if (configuredPiCommand !== undefined) {
		piCommand = configuredPiCommand;
		if (configuredObserverPiCommand === undefined) {
			observerPiCommand = assertObserverPiCommand(configuredPiCommand);
		}
	}
	if (configuredObserverPiCommand !== undefined) {
		observerPiCommand = configuredObserverPiCommand;
	}
	if (configuredConclaveModel !== undefined) {
		conclaveModel = configuredConclaveModel;
	}
	if (configuredConclaveMaxCostUsdPerTurn !== undefined) {
		conclaveMaxCostUsdPerTurn = configuredConclaveMaxCostUsdPerTurn;
	}
	if (configuredExecutorModel !== undefined) {
		executorModel = configuredExecutorModel;
	}
	if (configuredExecutorMaxCostUsdPerTurn !== undefined) {
		executorMaxCostUsdPerTurn = configuredExecutorMaxCostUsdPerTurn;
	}
	if (configuredOracleModel !== undefined) {
		oracleModel = configuredOracleModel;
	}
	if (configuredObserverModel !== undefined) {
		observerModel = configuredObserverModel;
	}
	if (configuredConclaveThinking !== undefined) {
		conclaveThinking = configuredConclaveThinking;
	}
	if (configuredExecutorThinking !== undefined) {
		executorThinking = configuredExecutorThinking;
	}
	if (configuredObserverThinking !== undefined) {
		observerThinking = configuredObserverThinking;
	}
	if (configuredPullRequestTargetBranch !== undefined) {
		pullRequestTargetBranch = configuredPullRequestTargetBranch;
	}
	if (configuredCommitConvention !== undefined) {
		commitConvention = configuredCommitConvention;
	}
	if (configuredArchiveRoot !== undefined) {
		archiveRoot = expandHome(configuredArchiveRoot);
	}
	return {
		worktreeRoot,
		worktreeBranchPrefix,
		launcher,
		piCommand,
		observerPiCommand,
		conclaveModel,
		conclaveMaxCostUsdPerTurn,
		executorModel,
		executorMaxCostUsdPerTurn,
		oracleModel,
		observerModel,
		conclaveThinking,
		executorThinking,
		observerThinking,
		pullRequestTargetBranch,
		commitConvention,
		archiveRoot,
	};
}

function readConfigFile(configPath: string): ConfigValues | undefined {
	if (!existsSync(configPath)) {
		return;
	}

	const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
	if (!isRecord(parsed)) {
		throw new Error(`Khala config must be an object: ${configPath}`);
	}
	return parsed;
}

function expandHome(path: string): string {
	if (path === "~") {
		return homedir();
	}
	if (path.startsWith("~/")) {
		return join(homedir(), path.slice("~/".length));
	}
	return path;
}

function isRecord(value: unknown): value is ConfigValues {
	return typeof value === "object" && value !== null;
}

function readLauncher(config: ConfigValues, key: string): LauncherNameValue | undefined {
	if (!(key in config)) {
		return;
	}
	const value = config[key];
	if (value === LauncherName.zellij || value === LauncherName.tmux || value === LauncherName.herdr) {
		return value;
	}
	throw new Error(`Khala config field '${key}' must be one of: zellij, tmux, herdr.`);
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function readThinkingLevel(config: ConfigValues, key: string): ThinkingLevel | "" | undefined {
	if (!(key in config)) {
		return;
	}
	const value = config[key];
	if (value === "") {
		return "";
	}
	if (typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel)) {
		return value as ThinkingLevel;
	}
	throw new Error(`Khala config field '${key}' must be a supported thinking level or an empty string.`);
}

function readConfigString(config: ConfigValues, key: string): string | undefined {
	const value = readConfigText(config, key);
	if (value === undefined || value.trim().length === 0) {
		return;
	}
	return value;
}

function readPositiveFiniteNumber(config: ConfigValues, key: string): number | undefined {
	if (!(key in config)) {
		return;
	}
	const value = config[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Khala config field '${key}' must be a finite number greater than zero.`);
	}
	return value;
}

function readConfigText(config: ConfigValues, key: string): string | undefined {
	if (!(key in config)) {
		return;
	}
	const value = config[key];
	if (typeof value !== "string") {
		throw new Error(`Khala config field '${key}' must be a string.`);
	}
	return value;
}

function readRequiredConfigString(config: ConfigValues, key: string): string | undefined {
	const value = readConfigText(config, key);
	if (key in config && (value === undefined || value.trim().length === 0)) {
		throw new Error(`Khala config field '${key}' must be a non-empty string.`);
	}
	return value;
}

function resolveEffectiveWorkBudget(
	work: Pick<KhalaWork, "costBudget">,
	config: Pick<KhalaConfig, "conclaveMaxCostUsdPerTurn" | "executorMaxCostUsdPerTurn">,
): EffectiveWorkBudget {
	return {
		conclaveMaxCostUsdPerTurn: work.costBudget?.conclaveMaxCostUsdPerTurn ?? config.conclaveMaxCostUsdPerTurn,
		executorMaxCostUsdPerTurn: work.costBudget?.executorMaxCostUsdPerTurn ?? config.executorMaxCostUsdPerTurn,
	};
}

function validateRequiredSupervisionConfig(config: KhalaConfig): void {
	const missing: string[] = [];
	if (config.conclaveModel.trim().length === 0) {
		missing.push("conclaveModel");
	}
	if (!isPositiveFiniteNumber(config.conclaveMaxCostUsdPerTurn)) {
		missing.push("conclaveMaxCostUsdPerTurn");
	}
	if (config.executorModel.trim().length === 0) {
		missing.push("executorModel");
	}
	if (!isPositiveFiniteNumber(config.executorMaxCostUsdPerTurn)) {
		missing.push("executorMaxCostUsdPerTurn");
	}
	if (missing.length > 0) {
		throw new KhalaSupervisionConfigError(missing);
	}
}

function isPositiveFiniteNumber(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function readObserverPiCommand(config: ConfigValues, key: string): PiCommand | undefined {
	const command = readPiCommand(config, key);
	if (command === undefined) {
		return;
	}
	return assertObserverPiCommand(command);
}

function assertObserverPiCommand(command: readonly string[]): PiCommand {
	const [programPath, ...arguments_] = command;
	const program = basename(programPath ?? "")
		.replace(PI_COMMAND_SUFFIX_PATTERN, "")
		.toLowerCase();
	if (program !== "pi") {
		throw new Error("Khala Observer only supports the Pi command; configure observerPiCommand to a pi executable.");
	}
	return [programPath ?? "pi", ...arguments_];
}

function readPiCommand(config: ConfigValues, key: string): PiCommand | undefined {
	if (!(key in config)) {
		return;
	}
	const value = config[key];
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`Khala config field '${key}' must be a non-empty command array or string.`);
	}
	const [command, ...parts] = value as unknown[];
	if (typeof command !== "string" || command.trim().length === 0) {
		throw new Error(`Khala config field '${key}' must start with a non-empty command.`);
	}
	const args: string[] = [];
	for (const part of parts) {
		if (typeof part !== "string" || part.trim().length === 0) {
			throw new Error(`Khala config field '${key}' command arguments must be non-empty strings.`);
		}
		args.push(part);
	}
	return [command, ...args];
}

export type { ConfigScopeValue, EffectiveWorkBudget, KhalaConfig, LauncherNameValue };
export {
	assertObserverPiCommand,
	ConfigScope,
	getKhalaConfigPath,
	KHALA_SETUP_COMMAND,
	KhalaConfigError,
	KhalaSupervisionConfigError,
	LauncherName,
	loadKhalaConfig,
	resolveEffectiveWorkBudget,
	THINKING_LEVELS,
	validateRequiredSupervisionConfig,
};
